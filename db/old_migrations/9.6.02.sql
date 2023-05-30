-- update the distribution taxes based on tax populated in distribution_payments
with data as (
  select 
    distribution_id, 
    round(sum(amount * tax / 1000000)) as calculated_tax
  from 
    distribution_payments dp
  group by 
    distribution_id
)
update 
  distributions d
set 
  taxes = data.calculated_tax
from 
  data 
where
  data.distribution_id = d.id;

-- add amount_after_tax column to distribution_payments
alter table distribution_payments add column if not exists amount_after_tax numeric;

update
  distribution_payments
set
  amount_after_tax = amount - round(amount * tax / 1000000);
