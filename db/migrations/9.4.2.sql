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