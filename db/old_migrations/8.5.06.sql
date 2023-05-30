-- Schema was altered to make `TickerExternalAgentAction.callerId` nullable
ALTER TABLE ticker_external_agent_actions ALTER COLUMN caller_id DROP NOT NULL;
