# Supabase RPC Function Analysis - `create_account_atomic`

## ⚠️ Current Issue
The `create_account_atomic()` RPC function is **NOT returning all required fields**, specifically the `is_new_user` field is missing.

## Required Database Schema

### Tables Expected:

#### 1. `users` table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  signature_name TEXT,
  onboarding_completed BOOLEAN DEFAULT FALSE,
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
```

#### 2. `accounts` table
```sql
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  stripe_customer_id TEXT,
  is_suspended BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
```

#### 3. `account_members` table
```sql
CREATE TABLE account_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, user_id)
);
```

#### 4. `balances` table
```sql
CREATE TABLE balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE UNIQUE,
  credit_balance INTEGER NOT NULL DEFAULT 0,
  light_analyses_balance INTEGER NOT NULL DEFAULT 0,
  last_transaction_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## RPC Function: `create_account_atomic`

### What the TypeScript code expects:

#### Input Parameters:
- `p_user_id` (UUID) - Deterministic UUID from Google ID
- `p_email` (TEXT) - User's email
- `p_full_name` (TEXT) - User's full name
- `p_avatar_url` (TEXT) - Profile picture URL

#### Expected Return Fields:
```typescript
{
  user_id: string;          // ✅ Currently returned
  account_id: string;       // ✅ Currently returned
  email: string;            // ✅ Currently returned
  full_name: string;        // ✅ Currently returned
  onboarding_completed: boolean;  // ✅ Currently returned
  credit_balance: number;   // ✅ Currently returned
  is_new_user: boolean;     // ❌ MISSING - This is the problem!
}
```

### Recommended RPC Function Implementation:

```sql
CREATE OR REPLACE FUNCTION create_account_atomic(
  p_user_id UUID,
  p_email TEXT,
  p_full_name TEXT,
  p_avatar_url TEXT
)
RETURNS TABLE (
  user_id UUID,
  account_id UUID,
  email TEXT,
  full_name TEXT,
  onboarding_completed BOOLEAN,
  credit_balance INTEGER,
  is_new_user BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id UUID;
  v_user_exists BOOLEAN;
  v_onboarding_completed BOOLEAN;
  v_credit_balance INTEGER;
BEGIN
  -- Check if user already exists
  SELECT EXISTS(SELECT 1 FROM users WHERE id = p_user_id) INTO v_user_exists;

  -- Create or update user
  INSERT INTO users (id, email, full_name, avatar_url, onboarding_completed)
  VALUES (p_user_id, p_email, p_full_name, p_avatar_url, FALSE)
  ON CONFLICT (id) DO UPDATE
    SET
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      avatar_url = EXCLUDED.avatar_url,
      updated_at = NOW();

  IF NOT v_user_exists THEN
    -- NEW USER: Create account
    INSERT INTO accounts (owner_id, name, slug)
    VALUES (
      p_user_id,
      p_full_name || '''s Account',
      'account-' || EXTRACT(EPOCH FROM NOW())::TEXT
    )
    RETURNING id INTO v_account_id;

    -- Add user as owner
    INSERT INTO account_members (account_id, user_id, role)
    VALUES (v_account_id, p_user_id, 'owner');

    -- Create balance with 25 free credits
    INSERT INTO balances (account_id, credit_balance, light_analyses_balance)
    VALUES (v_account_id, 25, 0);

    v_credit_balance := 25;
    v_onboarding_completed := FALSE;

  ELSE
    -- EXISTING USER: Get existing account
    SELECT a.id INTO v_account_id
    FROM accounts a
    INNER JOIN account_members am ON am.account_id = a.id
    WHERE am.user_id = p_user_id AND am.role = 'owner'
    LIMIT 1;

    -- Get credit balance
    SELECT b.credit_balance INTO v_credit_balance
    FROM balances b
    WHERE b.account_id = v_account_id;

    -- Check if any business profile is completed
    SELECT EXISTS(
      SELECT 1 FROM business_profiles
      WHERE account_id = v_account_id AND onboarding_completed = TRUE
    ) INTO v_onboarding_completed;
  END IF;

  -- Return all required fields
  RETURN QUERY SELECT
    p_user_id,
    v_account_id,
    p_email,
    p_full_name,
    v_onboarding_completed,
    COALESCE(v_credit_balance, 0),
    NOT v_user_exists;  -- is_new_user

END;
$$;
```

## Current Workaround in TypeScript

Because the RPC doesn't return `is_new_user`, we added this workaround:

```typescript
// Check if user already exists to determine new user status
const { data: existingUser } = await supabase
  .from('users')
  .select('id')
  .eq('id', userId)
  .single();

const isNewUser = !existingUser;
```

This works but requires an **extra database query** before the RPC call.

## Recommended Fix

**Update the `create_account_atomic` RPC function in Supabase** to include the `is_new_user` field in its return value (see SQL above).

This will:
1. ✅ Remove the need for the extra database query
2. ✅ Make the function truly atomic
3. ✅ Ensure `isNewUser` is accurate and consistent
4. ✅ Improve performance

## Testing the Fix

After updating the RPC function, you can test with:

```sql
-- Test new user
SELECT * FROM create_account_atomic(
  'test-uuid-here'::UUID,
  'test@example.com',
  'Test User',
  'https://example.com/avatar.jpg'
);

-- Should return is_new_user = TRUE

-- Run again
SELECT * FROM create_account_atomic(
  'test-uuid-here'::UUID,
  'test@example.com',
  'Test User',
  'https://example.com/avatar.jpg'
);

-- Should return is_new_user = FALSE
```

## Related Code Files
- `src/features/auth/auth.handler.ts` - OAuth callback handler
- `src/features/auth/auth.types.ts` - AuthResponse interface
