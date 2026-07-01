CREATE INDEX "access_tokens_exp_idx" ON "access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "challenges_exp_idx" ON "challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_exp_idx" ON "sessions" USING btree ("expires_at");