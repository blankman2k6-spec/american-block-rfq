// American Block Sales OS v5.5.0 — administrator-only user management
// Required Supabase Edge Function secrets/environment:
// SUPABASE_URL (provided by Supabase)
// SUPABASE_ANON_KEY (provided by Supabase)
// SUPABASE_SERVICE_ROLE_KEY (provided by Supabase)
// AI_KEY_ENCRYPTION_SECRET (set this yourself to a long random secret)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status=200){
  return new Response(JSON.stringify(data),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});
}
function bytesToB64(bytes: Uint8Array){
  let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);
}
async function encryptionKey(){
  const secret=Deno.env.get("AI_KEY_ENCRYPTION_SECRET");
  if(!secret)throw new Error("AI_KEY_ENCRYPTION_SECRET is not configured.");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptSecret(value:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await encryptionKey();
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value)));
  return JSON.stringify({v:1,iv:bytesToB64(iv),cipher:bytesToB64(cipher)});
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST")return json({error:"POST required"},405);
  try{
    const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
    const anonKey=Deno.env.get("SUPABASE_ANON_KEY")||"";
    const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
    if(!supabaseUrl||!anonKey||!serviceKey)return json({error:"Supabase server configuration is incomplete."},500);

    const authHeader=req.headers.get("Authorization")||"";
    if(!authHeader.startsWith("Bearer "))return json({error:"Authentication required."},401);

    const callerClient=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
    const {data:userData,error:userError}=await callerClient.auth.getUser();
    if(userError||!userData.user)return json({error:"Invalid user session."},401);

    const admin=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:callerProfile,error:profileError}=await admin.from("app_users")
      .select("user_id,role,active").eq("user_id",userData.user.id).maybeSingle();
    if(profileError)return json({error:profileError.message},500);
    if(!callerProfile?.active||callerProfile?.role!=="admin")return json({error:"Administrator access required."},403);

    const body=await req.json();
    const action=String(body?.action||"");

    if(action==="list"){
      const [{data:profiles,error:pErr},{data:authData,error:aErr}]=await Promise.all([
        admin.from("app_users").select("user_id,display_name,role,active,ai_enabled,ai_key_encrypted,workspace_mode,created_at").order("created_at"),
        admin.auth.admin.listUsers({page:1,perPage:1000})
      ]);
      if(pErr)throw pErr;if(aErr)throw aErr;
      const emails=new Map((authData.users||[]).map(u=>[u.id,u.email||""]));
      return json({users:(profiles||[]).map(p=>({
        user_id:p.user_id,display_name:p.display_name,email:emails.get(p.user_id)||"",
        role:p.role,active:p.active,ai_enabled:p.ai_enabled,
        workspace_mode:p.workspace_mode,has_personal_ai_key:!!p.ai_key_encrypted
      }))});
    }

    if(action==="create"){
      const display_name=String(body?.display_name||"").trim();
      const email=String(body?.email||"").trim().toLowerCase();
      const password=String(body?.password||"");
      if(!display_name||!email||password.length<8)return json({error:"Name, email and 8+ character password are required."},400);
      const {data:created,error:createError}=await admin.auth.admin.createUser({
        email,password,email_confirm:true,user_metadata:{name:display_name}
      });
      if(createError)throw createError;
      const uid=created.user?.id;if(!uid)throw new Error("Auth user was not created.");
      const {error:insertError}=await admin.from("app_users").insert({
        user_id:uid,display_name,role:"user",active:true,ai_enabled:false,workspace_mode:"private"
      });
      if(insertError){
        await admin.auth.admin.deleteUser(uid).catch(()=>{});
        throw insertError;
      }
      return json({ok:true,user_id:uid,email,ai_enabled:false});
    }

    const targetUserId=String(body?.targetUserId||"");
    if(!targetUserId)return json({error:"targetUserId is required."},400);
    const {data:target,error:targetErr}=await admin.from("app_users")
      .select("user_id,role,active,ai_enabled,ai_key_encrypted").eq("user_id",targetUserId).maybeSingle();
    if(targetErr)throw targetErr;if(!target)return json({error:"User not found."},404);

    if(action==="update_user"){
      // Sole administrator cannot be disabled or demoted through the app.
      if(target.role==="admin"&&body?.active===false)return json({error:"The sole administrator cannot be disabled."},400);
      const updates:any={updated_at:new Date().toISOString()};
      if(body?.display_name!==undefined)updates.display_name=String(body.display_name||"").trim();
      if(body?.active!==undefined)updates.active=!!body.active;
      const {error}=await admin.from("app_users").update(updates).eq("user_id",targetUserId);
      if(error)throw error;
      return json({ok:true});
    }

    if(action==="set_ai_key"){
      if(target.role==="admin")return json({error:"Administrator AI uses the server OPENAI_API_KEY."},400);
      const apiKey=String(body?.apiKey||"").trim();
      if(!/^sk-[A-Za-z0-9_-]{20,}$/.test(apiKey))return json({error:"That does not look like an OpenAI API key."},400);
      const encrypted=await encryptSecret(apiKey);
      const {error}=await admin.from("app_users").update({
        ai_key_encrypted:encrypted,ai_enabled:true,updated_at:new Date().toISOString()
      }).eq("user_id",targetUserId);
      if(error)throw error;
      return json({ok:true});
    }

    if(action==="clear_ai_key"){
      if(target.role==="admin")return json({error:"Administrator server key is managed in Supabase secrets."},400);
      const {error}=await admin.from("app_users").update({
        ai_key_encrypted:null,ai_enabled:false,updated_at:new Date().toISOString()
      }).eq("user_id",targetUserId);
      if(error)throw error;
      return json({ok:true});
    }

    if(action==="set_ai_enabled"){
      if(target.role==="admin")return json({error:"Administrator AI remains enabled."},400);
      const enabled=!!body?.ai_enabled;
      if(enabled&&!target.ai_key_encrypted)return json({error:"Save this user's personal OpenAI API key before enabling AI."},400);
      const {error}=await admin.from("app_users").update({ai_enabled:enabled,updated_at:new Date().toISOString()}).eq("user_id",targetUserId);
      if(error)throw error;
      return json({ok:true});
    }

    return json({error:"Unsupported admin action."},400);
  }catch(error){
    return json({error:error instanceof Error?error.message:String(error)},500);
  }
});
