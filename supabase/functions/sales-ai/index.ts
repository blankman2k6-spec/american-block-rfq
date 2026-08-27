// Supabase Edge Function: sales-ai
// Secrets to configure in Supabase:
// OPENAI_API_KEY=...
// OPENAI_MODEL=gpt-5-mini   (optional; choose a currently supported model)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}


function b64ToBytes(value:string){
  const raw=atob(value);const out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}
async function aiEncryptionKey(){
  const secret=Deno.env.get("AI_KEY_ENCRYPTION_SECRET");
  if(!secret)throw new Error("AI_KEY_ENCRYPTION_SECRET is not configured.");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["decrypt"]);
}
async function decryptAiSecret(value:string){
  const payload=JSON.parse(value);
  const key=await aiEncryptionKey();
  const plain=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:b64ToBytes(String(payload.iv||""))},
    key,b64ToBytes(String(payload.cipher||""))
  );
  return new TextDecoder().decode(plain);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
    const anonKey=Deno.env.get("SUPABASE_ANON_KEY")||"";
    const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
    const authHeader=req.headers.get("Authorization")||"";
    if(!authHeader.startsWith("Bearer "))return json({error:"Authentication required."},401);
    if(!supabaseUrl||!anonKey||!serviceKey)return json({error:"Supabase server configuration is incomplete."},500);

    const callerClient=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
    const {data:userData,error:userError}=await callerClient.auth.getUser();
    if(userError||!userData.user)return json({error:"Invalid user session."},401);

    const admin=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:profile,error:profileError}=await admin.from("app_users")
      .select("user_id,display_name,role,active,ai_enabled,ai_key_encrypted")
      .eq("user_id",userData.user.id).maybeSingle();
    if(profileError)return json({error:profileError.message},500);
    if(!profile?.active)return json({error:"This Sales OS user is disabled."},403);

    const body = await req.json();
    if (body?.mode === "health") return json({
      ok:true,service:"sales-ai",role:profile.role,
      aiEnabled:profile.role==="admin"||!!profile.ai_enabled,
      displayName:profile.display_name||userData.user.email||"User"
    });

    let apiKey="";
    if(profile.role==="admin"){
      apiKey=Deno.env.get("OPENAI_API_KEY")||"";
      if(!apiKey)return json({error:"Administrator OPENAI_API_KEY is not configured on the server."},500);
    }else{
      if(!profile.ai_enabled)return json({error:"AI is disabled for this private user. Ask the administrator to enable it."},403);
      if(!profile.ai_key_encrypted)return json({error:"No personal OpenAI API key is configured for this user."},403);
      apiKey=await decryptAiSecret(profile.ai_key_encrypted);
    }

    const model = Deno.env.get("OPENAI_MODEL") || "gpt-5-mini";

    // Business-card mode is intentionally separate from CRM analysis. Missing fields stay blank.
    if (body?.mode === "business_card") {
      const imageDataUrl=String(body?.imageDataUrl||"");
      if(!/^data:image\//i.test(imageDataUrl))return json({error:"A business-card image is required."},400);
      const cardSchema={type:"object",additionalProperties:false,required:["company","name","role","phone","email","website","address","city","state","zip"],properties:{company:{type:"string"},name:{type:"string"},role:{type:"string"},phone:{type:"string"},email:{type:"string"},website:{type:"string"},address:{type:"string"},city:{type:"string"},state:{type:"string"},zip:{type:"string"}}};
      const cardResponse=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model,instructions:"Read the business card exactly. Extract only information visibly present or unambiguously implied by the printed address. Never invent missing information. Use empty strings for fields not shown. company is the business/company name; name is the person's name; role is title/department. Return JSON only.",input:[{role:"user",content:[{type:"input_text",text:"Extract this business card so I can create a CRM customer and contact."},{type:"input_image",image_url:imageDataUrl}]}],text:{format:{type:"json_schema",name:"business_card",strict:true,schema:cardSchema}}})});
      const rawCard=await cardResponse.text();let cardPayload:any;try{cardPayload=JSON.parse(rawCard)}catch{cardPayload=null}
      if(!cardResponse.ok)return json({error:cardPayload?.error?.message||rawCard||`OpenAI HTTP ${cardResponse.status}`},502);
      let cardText=cardPayload?.output_text||"";if(!cardText&&Array.isArray(cardPayload?.output)){for(const item of cardPayload.output){if(item?.type!=="message")continue;for(const c of item?.content||[]){if(c?.type==="output_text"&&c?.text)cardText+=c.text}}}
      try{return json({card:JSON.parse(cardText)})}catch{return json({error:"Business card returned invalid structured output."},502)}
    }

    const writePolicy = body?.writePolicy === "readonly" ? "readonly" : "approval";

    const instructions = `
You are the embedded Sales AI for American Block Sales OS, an outside-sales CRM for oilfield flow iron and pressure-control products.

Be analytical, practical, concise, and grounded ONLY in the CRM context supplied by the application.
Never invent orders, prices, contacts, customer statements, inventory, or follow-up dates.
Distinguish closed sales, open RFQs, opportunities, and backorders.
When making recommendations, explain the business reason.

You may PROPOSE CRM writes, but you never execute them. The browser shows every proposed write to the user for approval.
Write policy: ${writePolicy}.

Supported proposed action types and the JSON object that must be encoded in payloadJson:
1. create_activity
   { customerId, contactId?, date, activityType, comments, opportunityRfqId?, opportunityTitle?, opportunityValue?, opportunityStage?, opportunityDetails? }
2. update_customer_notes
   { customerId, note }
3. update_customer_profile
   { customerId, website?, businessDescription?, websiteFitSummary?, buyingDrivers?, knownSuppliers?, notes?, recommendedProducts?:[{product,reason,application?}] }
4. create_rfq
   { customerId, contactId?, quoteNo?, status?, followup?, nextAction?, feedback?, shipping?, tax?, items:[{part,product,qty,price}] }
5. update_rfq
   { rfqId, status?, followup?, nextAction?, feedback?, quoteNo?, items? }
6. set_followup
   { rfqId, followup, nextAction? }

For every proposed action, payloadJson MUST be a valid JSON string encoding exactly one JSON object for that action. Example: {"customerId":"abc","note":"Follow up next week"} must be returned as the string value of payloadJson, not as a nested free-form object. The server will safely parse payloadJson back into payload before returning it to the CRM.
If information needed for a write is missing, do not guess it; omit the action or clearly state what is missing.
If writePolicy is readonly, proposedActions must be [].

For product recommendations, use the flowlineCatalog supplied inside CRM context as the source of truth. Do not invent catalog products, part numbers, sizes, pressure ratings, or applications.
For website research, use web results only to establish what the company actually does; then map those documented services to the supplied flowlineCatalog. Prefer the official company website. If direct access is blocked, use reliable public web sources that clearly refer to the same company, and clearly separate verified public-web facts from CRM history.

Return JSON only matching the requested schema.
`;

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["answer", "proposedActions"],
      properties: {
        answer: { type: "string" },
        proposedActions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "reason", "payloadJson"],
            properties: {
              type: { type: "string", enum: ["create_activity","update_customer_notes","update_customer_profile","create_rfq","update_rfq","set_followup"] },
              reason: { type: "string" },
              payloadJson: { type: "string", description: "A JSON-encoded object containing the action payload." }
            }
          }
        }
      }
    };

    const userPayload = {
      question: String(body?.question || ""),
      mode: body?.mode || "chat",
      customerId: body?.customerId || "",
      website: String(body?.website || ""),
      conversation: Array.isArray(body?.conversation) ? body.conversation : [],
      crm: body?.context || {},
    };

    const requestBody: any = {
      model,
      instructions,
      input: JSON.stringify(userPayload),
      text: {
        format: {
          type: "json_schema",
          name: "sales_ai_response",
          strict: true,
          schema
        }
      }
    };

    // Website intelligence is opt-in and constrained to the customer domain when possible.
    if (body?.mode === "website_research") {
      let domain = "";
      try { domain = new URL(String(body?.website || "")).hostname.replace(/^www\./, ""); } catch {}
      requestBody.tools = [{
        type: "web_search",
        search_context_size: "medium",
        ...(domain ? { filters: { allowed_domains: [domain] } } : {})
      }];
      requestBody.tool_choice = "auto";
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const raw = await response.text();
    let payload: any;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok) {
      return json({ error: payload?.error?.message || raw || `OpenAI HTTP ${response.status}` }, 502);
    }

    // Responses API returns convenience output_text in SDKs, while REST output
    // contains message content. Support either representation.
    let outputText = payload?.output_text || "";
    if (!outputText && Array.isArray(payload?.output)) {
      for (const item of payload.output) {
        if (item?.type !== "message") continue;
        for (const c of item?.content || []) {
          if (c?.type === "output_text" && c?.text) outputText += c.text;
        }
      }
    }
    if (!outputText) return json({ error: "OpenAI returned no text output." }, 502);

    let parsed: any;
    try { parsed = JSON.parse(outputText); }
    catch { return json({ error: "AI returned invalid structured output.", raw: outputText }, 502); }

    // Structured Outputs requires closed object schemas (additionalProperties:false).
    // Action payloads vary by action type, so the model returns each payload as a
    // JSON string and we decode it here before sending the response to Sales OS.
    const normalizedActions: any[] = [];
    for (const action of Array.isArray(parsed?.proposedActions) ? parsed.proposedActions : []) {
      let actionPayload: any = {};
      try {
        const decoded = JSON.parse(String(action?.payloadJson || "{}"));
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) actionPayload = decoded;
      } catch {
        return json({ error: `AI returned invalid payload JSON for ${String(action?.type || "action")}.` }, 502);
      }
      normalizedActions.push({
        type: String(action?.type || ""),
        reason: String(action?.reason || ""),
        payload: actionPayload,
      });
    }

    return json({
      answer: String(parsed?.answer || ""),
      proposedActions: writePolicy === "readonly" ? [] : normalizedActions,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
