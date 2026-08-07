-- American Block Sales OS v3 starter schema
create extension if not exists "pgcrypto";

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  city text,
  address text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  name text not null,
  role text,
  phone text,
  email text,
  location text,
  is_primary boolean default false,
  created_at timestamptz default now()
);

create table if not exists rfqs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  quote_no text,
  status text,
  followup_date date,
  feedback text,
  next_action text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists rfq_items (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid references rfqs(id) on delete cascade,
  part_number text,
  product_description text,
  quantity numeric,
  unit_price numeric
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  linked_rfq_id uuid references rfqs(id) on delete set null,
  sales_order text,
  po_number text,
  order_date date,
  total numeric,
  file_name text,
  imported_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete cascade,
  part_number text,
  product_description text,
  quantity numeric,
  unit_price numeric
);

create table if not exists communications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  rfq_id uuid references rfqs(id) on delete set null,
  type text,
  template text,
  message text,
  created_at timestamptz default now()
);

-- RLS should be enabled after user authentication is added.
