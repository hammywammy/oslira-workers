#!/bin/bash
# deploy-aws-secrets.sh - AWS Secrets Manager setup for Oslira
# SIMPLE MANUAL STORAGE ONLY - NO LAMBDA, NO AUTO-ROTATION

set -e

echo "🚀 Setting up AWS Secrets Manager for Oslira"

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
SECRETS_PREFIX="Oslira"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI not found. Install it first."
        exit 1
    fi
    
    if ! aws sts get-caller-identity &> /dev/null; then
        print_error "AWS credentials not configured. Run 'aws configure' first."
        exit 1
    fi
    
    print_success "Prerequisites OK"
}

# Create secrets with environment prefix
create_secrets() {
    print_status "Creating secrets in AWS Secrets Manager..."
    echo ""
    
    # Prompt for environment
    echo "Which environment?"
    echo "1) production"
    echo "2) staging"
    read -p "Choice (1 or 2): " env_choice
    
    case $env_choice in
        1) ENV_NAME="production" ;;
        2) ENV_NAME="staging" ;;
        *) print_error "Invalid choice"; exit 1 ;;
    esac
    
    print_status "Setting up: ${ENV_NAME}"
    echo ""
    
    # Get keys from user
    read -p "Supabase URL: " SUPABASE_URL
    read -p "Frontend URL: " FRONTEND_URL
    read -p "Apify token: " -s APIFY_TOKEN; echo
    read -p "Claude key: " -s CLAUDE_KEY; echo
    read -p "OpenAI key: " -s OPENAI_KEY; echo
    read -p "Stripe webhook: " -s STRIPE_WEBHOOK; echo
    read -p "Stripe secret: " -s STRIPE_SECRET; echo
    read -p "Stripe publishable: " STRIPE_PUBLISHABLE
    read -p "Supabase service role: " -s SUPABASE_SERVICE_ROLE; echo
    read -p "Supabase anon: " SUPABASE_ANON
    echo ""
    
    # Create all secrets with environment prefix
    # Format: Oslira/production/KEY or Oslira/staging/KEY
    
    create_secret "${ENV_NAME}/SUPABASE_URL" "$SUPABASE_URL"
    create_secret "${ENV_NAME}/FRONTEND_URL" "$FRONTEND_URL"
    create_secret "${ENV_NAME}/APIFY_API_TOKEN" "$APIFY_TOKEN"
    create_secret "${ENV_NAME}/CLAUDE_API_KEY" "$CLAUDE_KEY"
    create_secret "${ENV_NAME}/OPENAI_API_KEY" "$OPENAI_KEY"
    create_secret "${ENV_NAME}/STRIPE_WEBHOOK_SECRET" "$STRIPE_WEBHOOK"
    create_secret "${ENV_NAME}/STRIPE_SECRET_KEY" "$STRIPE_SECRET"
    create_secret "${ENV_NAME}/STRIPE_PUBLISHABLE_KEY" "$STRIPE_PUBLISHABLE"
    create_secret "${ENV_NAME}/SUPABASE_SERVICE_ROLE" "$SUPABASE_SERVICE_ROLE"
    create_secret "${ENV_NAME}/SUPABASE_ANON_KEY" "$SUPABASE_ANON"
}

# Helper to create individual secret
create_secret() {
    local path="$1"
    local value="$2"
    
    if [ -z "$value" ]; then
        return
    fi
    
    aws secretsmanager create-secret \
        --name "${SECRETS_PREFIX}/${path}" \
        --description "Oslira ${path}" \
        --secret-string "{\"apiKey\":\"${value}\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"version\":\"v1\"}" \
        --region $AWS_REGION 2>/dev/null && print_success "✅ ${path}" || print_warning "⚠️  ${path} exists"
}

# Test retrieval
test_setup() {
    print_status "Testing retrieval..."
    
    local keys=("SUPABASE_URL" "FRONTEND_URL" "APIFY_API_TOKEN" "CLAUDE_API_KEY" "OPENAI_API_KEY" "STRIPE_WEBHOOK_SECRET" "STRIPE_SECRET_KEY" "STRIPE_PUBLISHABLE_KEY" "SUPABASE_SERVICE_ROLE" "SUPABASE_ANON_KEY")
    
    for key in "${keys[@]}"; do
        if aws secretsmanager get-secret-value \
            --secret-id "${SECRETS_PREFIX}/${ENV_NAME}/${key}" \
            --region $AWS_REGION &>/dev/null; then
            print_success "✅ ${ENV_NAME}/${key}"
        else
            print_warning "⚠️  ${ENV_NAME}/${key} not found"
        fi
    done
}

# Generate config guide
generate_guide() {
    local account_id=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "YOUR_ACCOUNT")
    
    cat > "cloudflare-env-${ENV_NAME}.txt" << EOF
# Cloudflare Worker Environment Variables for ${ENV_NAME}
# Add these to your worker configuration

AWS_ACCESS_KEY_ID=your-aws-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_REGION=${AWS_REGION}
AWS_ACCOUNT_ID=${account_id}
SECRETS_PREFIX=${SECRETS_PREFIX}
ADMIN_TOKEN=generate-secure-token-here
APP_ENV=${ENV_NAME}

# All API keys are in AWS at: ${SECRETS_PREFIX}/${ENV_NAME}/KEY_NAME
# Examples:
#   ${SECRETS_PREFIX}/${ENV_NAME}/OPENAI_API_KEY
#   ${SECRETS_PREFIX}/${ENV_NAME}/SUPABASE_URL
EOF
    
    print_success "Config saved: cloudflare-env-${ENV_NAME}.txt"
}

# Main
main() {
    echo "======================================================================"
    echo "🔑 AWS Secrets Manager Setup"
    echo "Simple storage only - NO Lambda, NO rotation"
    echo "======================================================================"
    echo ""
    
    check_prerequisites
    create_secrets
    test_setup
    generate_guide
    
    echo ""
    echo "======================================================================"
    print_success "✅ Setup complete for ${ENV_NAME}!"
    echo "======================================================================"
    echo ""
    echo "Next steps:"
    echo "1. Review cloudflare-env-${ENV_NAME}.txt"
    echo "2. Add variables to Cloudflare Worker"
    echo "3. Set APP_ENV=${ENV_NAME}"
    echo "4. Deploy worker"
    echo ""
}

main "$@"
