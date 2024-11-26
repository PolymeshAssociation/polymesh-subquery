-- convert all module names to lowercase
UPDATE multi_sig_proposals
SET params = jsonb_set(
    params,
    '{proposals}',
    (
        SELECT jsonb_agg(
            jsonb_set(
                proposal,
                '{module}',
                to_jsonb(lower(proposal->>'module'))
            )
        )
        FROM jsonb_array_elements(params->'proposals') AS proposal
    )
)
WHERE params->'proposals' IS NOT NULL;

-- correct the data format of 'params' when proposal with batch_all or batch_atomic is made
UPDATE multi_sig_proposals
SET params = jsonb_set(
    jsonb_set(params, '{isBatch}', 'true'),
    '{proposals}',
    (
        SELECT jsonb_agg(
            (
                elem - 'method' - 'section' -- Remove old keys
            ) || jsonb_build_object(
                'args', elem->>'args', -- stringify args
                'call', ltrim(
                    lower(
                        regexp_replace(
                            elem->>'method',
                            '([A-Z])',
                            '_\1',
                            'g'
                        )
                    ),
                    '_'
                ), -- Convert method to snake_case and set as 'call'
                'module', elem->>'section' -- Map section to module
            )
        )
        FROM jsonb_array_elements(params->'proposals') AS proposal,
             jsonb_array_elements((proposal->>'args')::jsonb->'calls') AS elem
    )
)
WHERE params->'proposals'->0->>'call' in ('batch_all', 'batch_atomic');
