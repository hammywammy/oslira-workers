// src/tests/repository-tests.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';

const createAdminClient = SupabaseClientFactory.createAdminClient;

export function registerRepositoryTests(app: Hono<{ Bindings: Env }>) {

  app.get('/test/repository/credits', async (c) => {
    try {
      const accountId = c.req.query('account_id');
      if (!accountId) {
        return c.json({ error: 'Missing account_id parameter' }, 400);
      }

      const supabase = await createAdminClient(c.env);
      const creditsRepo = new CreditsRepository(supabase);

      const balance = await creditsRepo.getBalance(accountId);
      const hasSufficient = await creditsRepo.hasSufficientCredits(accountId, 1);
      const transactions = await creditsRepo.getTransactions(accountId, { limit: 5 });

      return c.json({
        success: true,
        test: 'Credits Repository',
        account_id: accountId,
        current_balance: balance,
        has_sufficient_for_analysis: hasSufficient,
        recent_transactions: transactions.length,
        transactions: transactions.map(t => ({
          amount: t.amount,
          type: t.transaction_type,
          description: t.description
        }))
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });
}
