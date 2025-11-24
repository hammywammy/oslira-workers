// src/infrastructure/billing/stripe.service.ts

import Stripe from 'stripe';
import type { Env } from '@/shared/types/env.types';
import { getSecret } from '@/infrastructure/config/secrets';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';

/**
 * STRIPE SERVICE - PRODUCTION GRADE
 * 
 * Handles all Stripe API operations for Oslira:
 * - Customer creation during OAuth signup (ALL users)
 * - Metadata updates during onboarding completion
 * - Payment processing and subscription management
 * 
 * Key Features:
 * - Idempotent operations (safe retries)
 * - Lazy-loaded Stripe client (fetches secret on first use)
 * - Comprehensive error handling with detailed logging
 * - Metadata best practices (bidirectional lookup support)
 */

// =============================================================================
// TYPES
// =============================================================================

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

// =============================================================================
// SERVICE CLASS
// =============================================================================

export class StripeService {
  private stripe: Stripe | null = null;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Initialize Stripe client (lazy loading)
   * Only fetches secret when first Stripe operation is called
   */
  private async getStripeClient(): Promise<Stripe> {
    if (this.stripe) {
      return this.stripe;
    }

    console.log('[StripeService] Initializing Stripe client');

    const stripeKey = await getSecret('STRIPE_SECRET_KEY', this.env, this.env.APP_ENV);
    
    this.stripe = new Stripe(stripeKey, {
      apiVersion: '2024-12-18.acacia',
      typescript: true,
      maxNetworkRetries: 3, // Auto-retry on network failures
      timeout: 30000, // 30 second timeout
      appInfo: {
        name: 'Oslira',
        version: '1.0.0',
        url: 'https://oslira.com'
      }
    });

    console.log('[StripeService] ✓ Stripe client initialized');
    return this.stripe;
  }

  /**
   * Create Stripe customer
   * 
   * WHEN: Called during OAuth signup for ALL users (free and paid)
   * WHY: Ensures stripe_customer_id exists for future purchases
   * 
   * IDEMPOTENT: Checks for existing customer by email
   * - If customer exists → Returns existing ID (updates metadata if missing)
   * - If customer missing → Creates new customer
   * 
   * @param input - Customer creation data
   * @returns Stripe customer ID (cus_xxx)
   * @throws Error if Stripe API call fails
   */
  async createCustomer(input: CreateCustomerInput): Promise<string> {
    console.log('[StripeService] createCustomer() ENTRY', {
      email: input.email,
      account_id: input.account_id,
      user_id: input.user_id
    });

    const stripe = await this.getStripeClient();

    try {
      // =========================================================================
      // IDEMPOTENCY CHECK: Search for existing customer by email
      // =========================================================================
      
      const existingCustomers = await stripe.customers.list({
        email: input.email,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        const customer = existingCustomers.data[0];
        
        console.log('[StripeService] Customer already exists (idempotent return)', {
          customer_id: customer.id,
          email: input.email,
          has_account_id_metadata: !!customer.metadata?.account_id
        });

        // Edge case: Old customer missing our metadata
        if (!customer.metadata?.account_id) {
          console.log('[StripeService] Updating missing metadata on existing customer');

          await stripe.customers.update(customer.id, {
            metadata: {
              account_id: input.account_id,
              user_id: input.user_id,
              environment: this.env.APP_ENV,
              updated_at: new Date().toISOString(),
              ...input.metadata
            }
          });

          console.log('[StripeService] ✓ Metadata added to existing customer');
        }

        // Save to environment-specific column (for existing customers too)
        const isProduction = this.env.APP_ENV === 'production';
        const columnName = isProduction ? 'stripe_customer_id_live' : 'stripe_customer_id_test';

        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        await supabase
          .from('accounts')
          .update({
            [columnName]: customer.id
          })
          .eq('id', input.account_id);

        return customer.id;
      }

      // =========================================================================
      // CREATE NEW CUSTOMER
      // =========================================================================

      console.log('[StripeService] Creating new Stripe customer');

      const customer = await stripe.customers.create({
        email: input.email,
        name: input.name,
        metadata: {
          // Core identifiers (for bidirectional lookup)
          account_id: input.account_id,
          user_id: input.user_id,
          
          // Operational metadata
          environment: this.env.APP_ENV,
          created_via: 'oauth_signup',
          created_at: new Date().toISOString(),
          
          // Custom metadata from caller
          ...input.metadata
        },
        // Optional: Set preferred locales
        preferred_locales: ['en'],
      });

      console.log('[StripeService] ✓ Customer created successfully', {
        customer_id: customer.id,
        email: input.email,
        account_id: input.account_id
      });

      // Save to environment-specific column
      const isProduction = this.env.APP_ENV === 'production';
      const columnName = isProduction ? 'stripe_customer_id_live' : 'stripe_customer_id_test';

      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      await supabase
        .from('accounts')
        .update({
          [columnName]: customer.id
        })
        .eq('id', input.account_id);

      return customer.id;

    } catch (error: any) {
      console.error('[StripeService] ✗ Customer creation failed', {
        error_type: error.type,
        error_code: error.code,
        error_message: error.message,
        error_decline_code: error.decline_code,
        email: input.email,
        account_id: input.account_id
      });

      throw new Error(`Stripe customer creation failed: ${error.message}`);
    }
  }

  /**
   * Update customer metadata
   * 
   * WHEN: Called during onboarding completion
   * WHY: Adds business context (business_profile_id, onboarding status)
   * 
   * Metadata uses MERGE mechanism:
   * - New keys are added
   * - Existing keys are updated
   * - To delete a key, pass empty string as value
   * 
   * @param input - Customer ID and metadata to update
   * @throws Error if customer not found or API call fails
   */
  async updateCustomerMetadata(input: UpdateCustomerMetadataInput): Promise<void> {
    console.log('[StripeService] updateCustomerMetadata() ENTRY', {
      customer_id: input.customer_id,
      metadata_keys: Object.keys(input.metadata),
      metadata_count: Object.keys(input.metadata).length
    });

    const stripe = await this.getStripeClient();

    try {
      await stripe.customers.update(input.customer_id, {
        metadata: input.metadata
      });

      console.log('[StripeService] ✓ Customer metadata updated', {
        customer_id: input.customer_id
      });

    } catch (error: any) {
      console.error('[StripeService] ✗ Metadata update failed', {
        error_type: error.type,
        error_message: error.message,
        customer_id: input.customer_id
      });

      throw new Error(`Stripe metadata update failed: ${error.message}`);
    }
  }

  /**
   * Get customer by ID
   * 
   * @param customer_id - Stripe customer ID (cus_xxx)
   * @returns Customer object or null if deleted/not found
   */
  async getCustomer(customer_id: string): Promise<Stripe.Customer | null> {
    console.log('[StripeService] getCustomer() ENTRY', { customer_id });

    const stripe = await this.getStripeClient();

    try {
      const customer = await stripe.customers.retrieve(customer_id);
      
      // Handle deleted customers
      if (customer.deleted) {
        console.log('[StripeService] Customer is deleted', { customer_id });
        return null;
      }

      return customer as Stripe.Customer;

    } catch (error: any) {
      if (error.code === 'resource_missing') {
        console.log('[StripeService] Customer not found', { customer_id });
        return null;
      }

      console.error('[StripeService] Get customer failed', {
        error_message: error.message,
        customer_id
      });

      throw new Error(`Failed to retrieve customer: ${error.message}`);
    }
  }

  /**
   * Search customers by metadata
   * 
   * USE CASE: Find customer by account_id when stripe_customer_id missing from DB
   * NOTE: Objects must be indexed before appearing in search (may take a few minutes)
   * 
   * @param metadata_key - Metadata key to search (e.g., 'account_id')
   * @param metadata_value - Metadata value to match
   * @returns Array of matching customers
   */
  async searchCustomersByMetadata(
    metadata_key: string,
    metadata_value: string
  ): Promise<Stripe.Customer[]> {
    console.log('[StripeService] searchCustomersByMetadata() ENTRY', {
      metadata_key,
      metadata_value
    });

    const stripe = await this.getStripeClient();

    try {
      const result = await stripe.customers.search({
        query: `metadata['${metadata_key}']:'${metadata_value}'`,
        limit: 10
      });

      console.log('[StripeService] ✓ Customer search complete', {
        metadata_key,
        metadata_value,
        results_count: result.data.length
      });

      return result.data;

    } catch (error: any) {
      console.error('[StripeService] ✗ Customer search failed', {
        error_message: error.message,
        metadata_key,
        metadata_value
      });

      throw new Error(`Failed to search customers: ${error.message}`);
    }
  }

  /**
   * List all customers with pagination
   * 
   * USE CASE: Admin dashboard, analytics, data exports
   * 
   * @param limit - Number of customers to return (max 100)
   * @param starting_after - Customer ID to start after (for pagination)
   * @returns List of customers
   */
  async listCustomers(
    limit: number = 10,
    starting_after?: string
  ): Promise<{ data: Stripe.Customer[]; has_more: boolean }> {
    console.log('[StripeService] listCustomers() ENTRY', {
      limit,
      starting_after
    });

    const stripe = await this.getStripeClient();

    try {
      const result = await stripe.customers.list({
        limit: Math.min(limit, 100),
        starting_after
      });

      console.log('[StripeService] ✓ Customers listed', {
        count: result.data.length,
        has_more: result.has_more
      });

      return {
        data: result.data,
        has_more: result.has_more
      };

    } catch (error: any) {
      console.error('[StripeService] ✗ List customers failed', {
        error_message: error.message
      });

      throw new Error(`Failed to list customers: ${error.message}`);
    }
  }

  /**
   * Delete customer (soft delete)
   * 
   * WARNING: Deleting a customer:
   * - Cancels all active subscriptions immediately
   * - Cannot be undone
   * - Customer can still be retrieved via API (deleted flag set to true)
   * 
   * @param customer_id - Stripe customer ID
   */
  async deleteCustomer(customer_id: string): Promise<void> {
    console.log('[StripeService] deleteCustomer() ENTRY', {
      customer_id,
      warning: 'This will cancel all subscriptions'
    });

    const stripe = await this.getStripeClient();

    try {
      await stripe.customers.del(customer_id);

      console.log('[StripeService] ✓ Customer deleted', { customer_id });

    } catch (error: any) {
      console.error('[StripeService] ✗ Delete customer failed', {
        error_message: error.message,
        customer_id
      });

      throw new Error(`Failed to delete customer: ${error.message}`);
    }
  }
}
