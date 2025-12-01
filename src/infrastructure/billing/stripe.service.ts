import Stripe from 'stripe';
import type { Env } from '@/shared/types/env.types';
import { getSecret } from '@/infrastructure/config/secrets';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { logger } from '@/shared/utils/logger.util';

/**
 * Stripe Service - Production Grade
 *
 * Handles all Stripe API operations for Oslira:
 * - Customer creation during OAuth signup (ALL users)
 * - Metadata updates during onboarding completion
 * - Payment processing and subscription management
 */

export interface CreateCustomerInput {
  email: string;
  name: string;
  account_id: string;
  user_id: string;
  metadata?: Record<string, string>;
}

export interface UpdateCustomerMetadataInput {
  customer_id: string;
  metadata: Record<string, string>;
}

interface StripeError extends Error {
  type?: string;
  code?: string;
  decline_code?: string;
}

export class StripeService {
  private stripe: Stripe | null = null;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /** Initialize Stripe client (lazy loading) */
  private async getStripeClient(): Promise<Stripe> {
    if (this.stripe) {
      return this.stripe;
    }

    const stripeKey = await getSecret('STRIPE_SECRET_KEY', this.env, this.env.APP_ENV);

    this.stripe = new Stripe(stripeKey, {
      apiVersion: '2024-12-18.acacia',
      typescript: true,
      maxNetworkRetries: 3,
      timeout: 30000,
      appInfo: {
        name: 'Oslira',
        version: '1.0.0',
        url: 'https://oslira.com'
      }
    });

    return this.stripe;
  }

  /**
   * Create Stripe customer
   * IDEMPOTENT: Checks for existing customer by email
   */
  async createCustomer(input: CreateCustomerInput): Promise<string> {
    logger.info('Creating Stripe customer', {
      email: input.email,
      account_id: input.account_id,
      user_id: input.user_id
    });

    const stripe = await this.getStripeClient();

    try {
      const existingCustomers = await stripe.customers.list({
        email: input.email,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        const customer = existingCustomers.data[0];

        logger.info('Customer already exists', {
          customer_id: customer.id,
          email: input.email,
          has_account_id_metadata: !!customer.metadata?.account_id
        });

        if (!customer.metadata?.account_id) {
          await stripe.customers.update(customer.id, {
            metadata: {
              account_id: input.account_id,
              user_id: input.user_id,
              environment: this.env.APP_ENV,
              updated_at: new Date().toISOString(),
              ...input.metadata
            }
          });
        }

        const isProduction = this.env.APP_ENV === 'production';
        const columnName = isProduction ? 'stripe_customer_id_live' : 'stripe_customer_id_test';

        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        await supabase
          .from('accounts')
          .update({ [columnName]: customer.id })
          .eq('id', input.account_id);

        return customer.id;
      }

      const customer = await stripe.customers.create({
        email: input.email,
        name: input.name,
        metadata: {
          account_id: input.account_id,
          user_id: input.user_id,
          environment: this.env.APP_ENV,
          created_via: 'oauth_signup',
          created_at: new Date().toISOString(),
          ...input.metadata
        },
        preferred_locales: ['en'],
      });

      logger.info('Stripe customer created', {
        customer_id: customer.id,
        email: input.email,
        account_id: input.account_id
      });

      const isProduction = this.env.APP_ENV === 'production';
      const columnName = isProduction ? 'stripe_customer_id_live' : 'stripe_customer_id_test';

      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      await supabase
        .from('accounts')
        .update({ [columnName]: customer.id })
        .eq('id', input.account_id);

      return customer.id;

    } catch (error: unknown) {
      const stripeError = error as StripeError;
      logger.error('Customer creation failed', {
        error_type: stripeError.type,
        error_code: stripeError.code,
        error_message: stripeError.message,
        error_decline_code: stripeError.decline_code,
        email: input.email,
        account_id: input.account_id
      });

      throw new Error(`Stripe customer creation failed: ${stripeError.message}`);
    }
  }

  /** Update customer metadata */
  async updateCustomerMetadata(input: UpdateCustomerMetadataInput): Promise<void> {
    logger.info('Updating customer metadata', {
      customer_id: input.customer_id,
      metadata_keys: Object.keys(input.metadata)
    });

    const stripe = await this.getStripeClient();

    try {
      await stripe.customers.update(input.customer_id, {
        metadata: input.metadata
      });

      logger.info('Customer metadata updated', {
        customer_id: input.customer_id
      });

    } catch (error: unknown) {
      const stripeError = error as StripeError;
      logger.error('Metadata update failed', {
        error_type: stripeError.type,
        error_message: stripeError.message,
        customer_id: input.customer_id
      });

      throw new Error(`Stripe metadata update failed: ${stripeError.message}`);
    }
  }

  /** Get customer by ID */
  async getCustomer(customer_id: string): Promise<Stripe.Customer | null> {
    const stripe = await this.getStripeClient();

    try {
      const customer = await stripe.customers.retrieve(customer_id);

      if (customer.deleted) {
        logger.info('Customer is deleted', { customer_id });
        return null;
      }

      return customer as Stripe.Customer;

    } catch (error: unknown) {
      const stripeError = error as StripeError;
      if (stripeError.code === 'resource_missing') {
        logger.info('Customer not found', { customer_id });
        return null;
      }

      logger.error('Get customer failed', {
        error_message: stripeError.message,
        customer_id
      });

      throw new Error(`Failed to retrieve customer: ${stripeError.message}`);
    }
  }

  /** Search customers by metadata */
  async searchCustomersByMetadata(
    metadata_key: string,
    metadata_value: string
  ): Promise<Stripe.Customer[]> {
    const stripe = await this.getStripeClient();

    try {
      const result = await stripe.customers.search({
        query: `metadata['${metadata_key}']:'${metadata_value}'`,
        limit: 10
      });

      logger.info('Customer search complete', {
        metadata_key,
        metadata_value,
        results_count: result.data.length
      });

      return result.data;

    } catch (error: unknown) {
      const stripeError = error as StripeError;
      logger.error('Customer search failed', {
        error_message: stripeError.message,
        metadata_key,
        metadata_value
      });

      throw new Error(`Failed to search customers: ${stripeError.message}`);
    }
  }

  /** List all customers with pagination */
  async listCustomers(
    limit: number = 10,
    starting_after?: string
  ): Promise<{ data: Stripe.Customer[]; has_more: boolean }> {
    const stripe = await this.getStripeClient();

    try {
      const result = await stripe.customers.list({
        limit: Math.min(limit, 100),
        starting_after
      });

      logger.info('Customers listed', {
        count: result.data.length,
        has_more: result.has_more
      });

      return {
        data: result.data,
        has_more: result.has_more
      };

    } catch (error: unknown) {
      const stripeError = error as StripeError;
      logger.error('List customers failed', {
        error_message: stripeError.message
      });

      throw new Error(`Failed to list customers: ${stripeError.message}`);
    }
  }

  /** Delete customer (soft delete) - WARNING: Cancels all active subscriptions */
  async deleteCustomer(customer_id: string): Promise<void> {
    logger.warn('Deleting customer', {
      customer_id,
      warning: 'This will cancel all subscriptions'
    });

    const stripe = await this.getStripeClient();

    try {
      await stripe.customers.del(customer_id);

      logger.info('Customer deleted', { customer_id });

    } catch (error: unknown) {
      const stripeError = error as StripeError;
      logger.error('Delete customer failed', {
        error_message: stripeError.message,
        customer_id
      });

      throw new Error(`Failed to delete customer: ${stripeError.message}`);
    }
  }
}
