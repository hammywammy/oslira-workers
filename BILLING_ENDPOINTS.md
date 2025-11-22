# Billing Endpoints - Implementation Guide

## Overview

This document describes the newly implemented billing endpoints for Stripe subscription upgrades.

## What Was Implemented

### 1. Stripe Configuration (`src/config/stripe.config.ts`)
- **Stripe Price IDs**: Maps subscription tiers to Stripe Price IDs
- **Tier Types**: TypeScript types for tier names (free, growth, pro, agency, enterprise)
- **Utility Functions**:
  - `getStripePriceId(tier)`: Get Stripe Price ID for a tier
  - `getTierOrder(tier)`: Get tier hierarchy order (for validation)
  - `isValidUpgrade(fromTier, toTier)`: Validate upgrade path

### 2. Billing Handler (`src/features/billing/billing.handler.ts`)
Two main endpoints:

#### GET `/api/billing/subscription`
Returns current subscription details for authenticated user.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "accountId": "uuid",
    "tier": "growth",
    "status": "active",
    "stripeSubscriptionId": "sub_xxx",
    "stripeCustomerId": "cus_xxx",
    "currentPeriodStart": "2025-01-01T00:00:00Z",
    "currentPeriodEnd": "2025-02-01T00:00:00Z",
    "creditsRemaining": 250,
    "lightRemaining": 250,
    "createdAt": "2025-01-01T00:00:00Z",
    "updatedAt": "2025-01-01T00:00:00Z"
  }
}
```

#### POST `/api/billing/upgrade`
Creates Stripe Checkout session for subscription upgrade.

**Request:**
```json
{
  "newTier": "pro"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "success": true,
    "checkoutUrl": "https://checkout.stripe.com/...",
    "sessionId": "cs_xxx"
  }
}
```

**Validation:**
- Prevents downgrades (must upgrade to higher tier)
- Verifies Stripe customer exists
- Creates checkout session with correct price ID

### 3. Billing Routes (`src/features/billing/billing.routes.ts`)
Registers both endpoints with:
- **Authentication**: Required for all billing routes
- **Rate Limiting**: API_GENERAL rate limits applied

### 4. Updated Stripe Webhook Handler
Modified `handleCheckoutCompleted()` in `src/infrastructure/queues/stripe-webhook.consumer.ts`:

**Now Handles:**
1. **Subscription Upgrades** (`mode: 'subscription'`):
   - Updates `subscriptions` table with new tier
   - Stores `stripe_subscription_id`
   - Resets balances to new tier limits
   - Reads tier limits from `plans` table

2. **One-Time Credit Purchases** (existing logic preserved)

### 5. Plans Table Setup (`sql/plans-setup.sql`)
SQL script to ensure `plans` table has correct tier data:
- Free: 0 credits, 0 light analyses
- Growth: 250 credits, 250 light analyses
- Pro: 1500 credits, 1500 light analyses
- Agency: 5000 credits, 5000 light analyses
- Enterprise: 20000 credits, 20000 light analyses

## Stripe Price IDs (Sandbox Mode)

```typescript
{
  growth: 'price_1SW21iFZyrcdK01tvTZ0ZbyJ',
  pro: 'price_1SW21tFZyrcdK01tVR91V4nW',
  agency: 'price_1SW220FZyrcdK01tja6a58UH',
  enterprise: 'price_1SW225FZyrcdK01tL0zd8t3A',
}
```

**Note:** These are sandbox/test mode Price IDs. Update in production.

## Redirect URLs

After checkout completion:
- **Success**: `https://app.oslira.com/upgrade?success=true&session_id={CHECKOUT_SESSION_ID}`
- **Cancel**: `https://app.oslira.com/upgrade?canceled=true`

## Database Requirements

### Run SQL Setup
Execute `sql/plans-setup.sql` to ensure plans table has correct data.

### Expected Tables
- `subscriptions`: Stores user subscriptions
- `plans`: Stores tier configurations
- `balances`: Stores credit balances
- `accounts`: Stores Stripe customer IDs

## Flow Diagram

```
User clicks upgrade → Frontend calls POST /api/billing/upgrade
                      ↓
              Creates Stripe Checkout session
                      ↓
              Redirects to Stripe Checkout
                      ↓
              User completes payment
                      ↓
              Stripe webhook: checkout.session.completed
                      ↓
              Updates subscription + balances
                      ↓
              Redirects to success URL
```

## Frontend Integration

### 1. Fetch Current Subscription
```typescript
const response = await fetch('/api/billing/subscription', {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});
const { data } = await response.json();
console.log(data.tier, data.creditsRemaining);
```

### 2. Trigger Upgrade
```typescript
const response = await fetch('/api/billing/upgrade', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ newTier: 'pro' })
});
const { data } = await response.json();
window.location.href = data.checkoutUrl;
```

### 3. Handle Redirect
```typescript
// On /upgrade page
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('success') === 'true') {
  // Show success message
  const sessionId = urlParams.get('session_id');
} else if (urlParams.get('canceled') === 'true') {
  // Show canceled message
}
```

## Testing

### Test Upgrade Flow
1. Use Stripe test mode
2. Call POST /api/billing/upgrade with test account
3. Complete checkout with test card: `4242 4242 4242 4242`
4. Verify webhook updates subscription
5. Verify balances are reset to new tier limits

### Test Cards
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 0002`

## Error Handling

| Error Code | Description |
|------------|-------------|
| `NOT_FOUND` | Subscription not found |
| `INVALID_UPGRADE` | Cannot downgrade via upgrade endpoint |
| `NO_STRIPE_CUSTOMER` | No Stripe customer ID found |
| `VALIDATION_ERROR` | Invalid request body |
| `INTERNAL_ERROR` | Server error |

## Security

- All endpoints require authentication
- Rate limiting applied
- Validates upgrade paths (no downgrades)
- Uses Stripe's secure checkout
- Webhook events are idempotent

## Monitoring

Key logs to watch:
- `[Upgrade] Checkout session created`
- `[StripeWebhook] Upgraded account`
- `[StripeWebhook] Failed to update subscription`

## Future Enhancements

- Add downgrade support (with prorated refunds)
- Add cancellation endpoint
- Add invoice history endpoint
- Add usage-based billing
- Add trial periods

## Files Modified/Created

### Created:
- `src/config/stripe.config.ts`
- `src/features/billing/billing.handler.ts`
- `src/features/billing/billing.routes.ts`
- `sql/plans-setup.sql`
- `BILLING_ENDPOINTS.md` (this file)

### Modified:
- `src/index.ts` - Registered billing routes
- `src/infrastructure/queues/stripe-webhook.consumer.ts` - Updated checkout handler
