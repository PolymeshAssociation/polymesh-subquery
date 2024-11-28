update instructions
set status = 'Failed'
where failure_reason is not null and status != 'Failed';