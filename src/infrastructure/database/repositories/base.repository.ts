// infrastructure/database/repositories/base.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * BASE REPOSITORY
 * Common database operations all repositories inherit
 */
export abstract class BaseRepository<T> {
  constructor(
    protected supabase: SupabaseClient,
    protected tableName: string
  ) {}

  /**
   * Find by ID
   */
  async findById(id: string): Promise<T | null> {
    const { data, error } = await this.supabase
      .from(this.tableName)
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;  // Not found
      throw error;
    }

    return data as T;
  }

  /**
   * Find many with filters
   */
  async findMany(filters: Record<string, any>, options?: {
    limit?: number;
    offset?: number;
    orderBy?: string;
    ascending?: boolean;
  }): Promise<T[]> {
    let query = this.supabase
      .from(this.tableName)
      .select('*')
      .is('deleted_at', null);

    // Apply filters
    Object.entries(filters).forEach(([key, value]) => {
      query = query.eq(key, value);
    });

    // Apply options
    if (options?.orderBy) {
      query = query.order(options.orderBy, { ascending: options.ascending ?? true });
    }
    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
    }

    const { data, error } = await query;

    if (error) throw error;
    return (data || []) as T[];
  }

  /**
   * Create record
   */
  async create(data: Partial<T>): Promise<T> {
    const { data: result, error } = await this.supabase
      .from(this.tableName)
      .insert(data)
      .select()
      .single();

    if (error) throw error;
    return result as T;
  }

  /**
   * Update record
   */
  async update(id: string, data: Partial<T>): Promise<T> {
    const { data: result, error } = await this.supabase
      .from(this.tableName)
      .update(data)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error) throw error;
    return result as T;
  }

  /**
   * Soft delete
   */
  async softDelete(id: string): Promise<void> {
    const { error } = await this.supabase
      .from(this.tableName)
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;
  }

  /**
   * Hard delete (rarely used)
   */
  async hardDelete(id: string): Promise<void> {
    const { error } = await this.supabase
      .from(this.tableName)
      .delete()
      .eq('id', id);

    if (error) throw error;
  }

  /**
   * Count records
   */
  async count(filters: Record<string, any> = {}): Promise<number> {
    let query = this.supabase
      .from(this.tableName)
      .select('*', { count: 'exact', head: true })
      .is('deleted_at', null);

    Object.entries(filters).forEach(([key, value]) => {
      query = query.eq(key, value);
    });

    const { count, error } = await query;

    if (error) throw error;
    return count || 0;
  }
}
