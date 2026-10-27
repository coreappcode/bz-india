-- Razorpay support (used only for INR checkouts on bzead.in).
-- Additive: existing Stripe orders and columns are untouched.

begin;

alter table public.orders
  add column if not exists payment_provider text,
  add column if not exists razorpay_payment_id text;

create unique index if not exists uq_orders_razorpay_payment_id
  on public.orders (razorpay_payment_id)
  where razorpay_payment_id is not null;

create table if not exists public.razorpay_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  event_type text not null,
  razorpay_order_id text,
  razorpay_payment_id text,
  status text not null default 'processed'
    check (status in ('processed', 'failed', 'skipped')),
  error_message text,
  payload jsonb,
  processed_at timestamptz default now(),
  created_at timestamptz default now()
);

create unique index if not exists uq_razorpay_event_processed
  on public.razorpay_webhook_events (event_id)
  where status = 'processed';

create index if not exists idx_razorpay_events_order
  on public.razorpay_webhook_events (razorpay_order_id);

create index if not exists idx_razorpay_events_failed
  on public.razorpay_webhook_events (status) where status = 'failed';

alter table public.razorpay_webhook_events enable row level security;

drop policy if exists "Only admins read razorpay events" on public.razorpay_webhook_events;
create policy "Only admins read razorpay events"
  on public.razorpay_webhook_events for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

commit;
