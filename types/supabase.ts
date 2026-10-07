export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          admin_id: string
          created_at: string | null
          id: string
          new_value: Json | null
          old_value: Json | null
          target_user_id: string
        }
        Insert: {
          action: string
          admin_id: string
          created_at?: string | null
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          target_user_id: string
        }
        Update: {
          action?: string
          admin_id?: string
          created_at?: string | null
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          target_user_id?: string
        }
        Relationships: []
      }
      admin_presence: {
        Row: {
          admin_id: string
          last_seen_at: string
        }
        Insert: {
          admin_id: string
          last_seen_at?: string
        }
        Update: {
          admin_id?: string
          last_seen_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_presence_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_custom_list_users: {
        Row: {
          added_at: string
          id: string
          list_id: string
          user_id: string
        }
        Insert: {
          added_at?: string
          id?: string
          list_id: string
          user_id: string
        }
        Update: {
          added_at?: string
          id?: string
          list_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_custom_list_users_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "admin_custom_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_custom_list_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_custom_lists: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      admin_payment_actions: {
        Row: {
          action: string
          admin_id: string | null
          created_at: string | null
          detail: Json | null
          id: string
          outcome: string | null
          reference: string | null
          source: string | null
        }
        Insert: {
          action: string
          admin_id?: string | null
          created_at?: string | null
          detail?: Json | null
          id?: string
          outcome?: string | null
          reference?: string | null
          source?: string | null
        }
        Update: {
          action?: string
          admin_id?: string | null
          created_at?: string | null
          detail?: Json | null
          id?: string
          outcome?: string | null
          reference?: string | null
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_payment_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_profit_logs: {
        Row: {
          admin_cost: number
          amount_paid_to_admin: number | null
          calculation_note: string
          channel: string
          created_at: string | null
          id: string
          is_loss: boolean | null
          profit: number
          role_at_time: string | null
          selling_price: number | null
          transaction_id: string
          transaction_type: string
        }
        Insert: {
          admin_cost: number
          amount_paid_to_admin?: number | null
          calculation_note: string
          channel: string
          created_at?: string | null
          id?: string
          is_loss?: boolean | null
          profit: number
          role_at_time?: string | null
          selling_price?: number | null
          transaction_id: string
          transaction_type: string
        }
        Update: {
          admin_cost?: number
          amount_paid_to_admin?: number | null
          calculation_note?: string
          channel?: string
          created_at?: string | null
          id?: string
          is_loss?: boolean | null
          profit?: number
          role_at_time?: string | null
          selling_price?: number | null
          transaction_id?: string
          transaction_type?: string
        }
        Relationships: []
      }
      admin_settings: {
        Row: {
          created_at: string | null
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          created_at?: string | null
          key: string
          updated_at?: string | null
          value: Json
        }
        Update: {
          created_at?: string | null
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      admin_settings_audit: {
        Row: {
          changed_at: string | null
          changed_by: string | null
          id: string
          key: string
          new_value: Json | null
          old_value: Json | null
          source: string | null
        }
        Insert: {
          changed_at?: string | null
          changed_by?: string | null
          id?: string
          key: string
          new_value?: Json | null
          old_value?: Json | null
          source?: string | null
        }
        Update: {
          changed_at?: string | null
          changed_by?: string | null
          id?: string
          key?: string
          new_value?: Json | null
          old_value?: Json | null
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_settings_audit_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      afa_orders: {
        Row: {
          api_key_id: string | null
          cost_price: number | null
          created_at: string | null
          date_of_birth: string | null
          full_name: string
          ghana_card: string
          guest_phone: string | null
          id: string
          id_number: string | null
          id_type: string | null
          location: string
          notes: string | null
          occupation: string
          parent_profit: number | null
          parent_shop_id: string | null
          payment_amount: number | null
          payment_method: string | null
          paystack_reference: string | null
          phone: string
          profit: number | null
          reference_code: string
          refund_method: string | null
          refund_reason: string | null
          refunded_at: string | null
          refunded_by: string | null
          region: string
          selling_price: number | null
          shop_id: string | null
          source: string
          status: string | null
          transaction_id: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          api_key_id?: string | null
          cost_price?: number | null
          created_at?: string | null
          date_of_birth?: string | null
          full_name: string
          ghana_card: string
          guest_phone?: string | null
          id?: string
          id_number?: string | null
          id_type?: string | null
          location: string
          notes?: string | null
          occupation: string
          parent_profit?: number | null
          parent_shop_id?: string | null
          payment_amount?: number | null
          payment_method?: string | null
          paystack_reference?: string | null
          phone: string
          profit?: number | null
          reference_code: string
          refund_method?: string | null
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          region: string
          selling_price?: number | null
          shop_id?: string | null
          source?: string
          status?: string | null
          transaction_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          api_key_id?: string | null
          cost_price?: number | null
          created_at?: string | null
          date_of_birth?: string | null
          full_name?: string
          ghana_card?: string
          guest_phone?: string | null
          id?: string
          id_number?: string | null
          id_type?: string | null
          location?: string
          notes?: string | null
          occupation?: string
          parent_profit?: number | null
          parent_shop_id?: string | null
          payment_amount?: number | null
          payment_method?: string | null
          paystack_reference?: string | null
          phone?: string
          profit?: number | null
          reference_code?: string
          refund_method?: string | null
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          region?: string
          selling_price?: number | null
          shop_id?: string | null
          source?: string
          status?: string | null
          transaction_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "afa_orders_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "afa_orders_parent_shop_id_fkey"
            columns: ["parent_shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "afa_orders_parent_shop_id_fkey"
            columns: ["parent_shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "afa_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "afa_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "afa_orders_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "wallet_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "afa_orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      airtime_fulfillment_batches: {
        Row: {
          batch_name: string
          completed_count: number
          created_at: string | null
          created_by: string | null
          failed_count: number
          fulfillment_service: string | null
          id: string
          notes: string | null
          order_count: number
          order_ids: string[]
          status: string
          updated_at: string | null
        }
        Insert: {
          batch_name: string
          completed_count?: number
          created_at?: string | null
          created_by?: string | null
          failed_count?: number
          fulfillment_service?: string | null
          id?: string
          notes?: string | null
          order_count?: number
          order_ids?: string[]
          status?: string
          updated_at?: string | null
        }
        Update: {
          batch_name?: string
          completed_count?: number
          created_at?: string | null
          created_by?: string | null
          failed_count?: number
          fulfillment_service?: string | null
          id?: string
          notes?: string | null
          order_count?: number
          order_ids?: string[]
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "airtime_fulfillment_batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      airtime_orders: {
        Row: {
          admin_fee_amount: number
          airtime_amount: number
          airtime_fulfillment_attempts: number
          api_key_id: string | null
          beneficiary_phone: string
          bundle_preference: string | null
          commission_amount: number | null
          commission_credited_at: string | null
          created_at: string | null
          fee_amount: number
          fee_rate: number
          fulfilled_at: string | null
          fulfilled_by: string | null
          fulfillment_metadata: Json | null
          fulfillment_note: string | null
          fulfillment_request_id: string | null
          fulfillment_service: string | null
          id: string
          network: string
          partner_commission_amount: number | null
          reference_code: string
          refund_reason: string | null
          refunded_at: string | null
          refunded_by: string | null
          shop_fee_amount: number
          shop_id: string | null
          shop_name: string | null
          source: string | null
          status: string | null
          total_paid: number
          type: string
          updated_at: string | null
          use_exact_amount: boolean | null
          user_id: string | null
          user_role: string
        }
        Insert: {
          admin_fee_amount?: number
          airtime_amount: number
          airtime_fulfillment_attempts?: number
          api_key_id?: string | null
          beneficiary_phone: string
          bundle_preference?: string | null
          commission_amount?: number | null
          commission_credited_at?: string | null
          created_at?: string | null
          fee_amount?: number
          fee_rate?: number
          fulfilled_at?: string | null
          fulfilled_by?: string | null
          fulfillment_metadata?: Json | null
          fulfillment_note?: string | null
          fulfillment_request_id?: string | null
          fulfillment_service?: string | null
          id?: string
          network: string
          partner_commission_amount?: number | null
          reference_code: string
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          shop_fee_amount?: number
          shop_id?: string | null
          shop_name?: string | null
          source?: string | null
          status?: string | null
          total_paid: number
          type?: string
          updated_at?: string | null
          use_exact_amount?: boolean | null
          user_id?: string | null
          user_role?: string
        }
        Update: {
          admin_fee_amount?: number
          airtime_amount?: number
          airtime_fulfillment_attempts?: number
          api_key_id?: string | null
          beneficiary_phone?: string
          bundle_preference?: string | null
          commission_amount?: number | null
          commission_credited_at?: string | null
          created_at?: string | null
          fee_amount?: number
          fee_rate?: number
          fulfilled_at?: string | null
          fulfilled_by?: string | null
          fulfillment_metadata?: Json | null
          fulfillment_note?: string | null
          fulfillment_request_id?: string | null
          fulfillment_service?: string | null
          id?: string
          network?: string
          partner_commission_amount?: number | null
          reference_code?: string
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          shop_fee_amount?: number
          shop_id?: string | null
          shop_name?: string | null
          source?: string | null
          status?: string | null
          total_paid?: number
          type?: string
          updated_at?: string | null
          use_exact_amount?: boolean | null
          user_id?: string | null
          user_role?: string
        }
        Relationships: [
          {
            foreignKeyName: "airtime_orders_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "airtime_orders_fulfilled_by_fkey"
            columns: ["fulfilled_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "airtime_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "airtime_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "airtime_orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          key_type: string
          last_used_at: string | null
          name: string
          rate_limits: Json | null
          status: string
          updated_at: string | null
          user_id: string
          webhook_secret: string | null
          webhook_url: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          key_type?: string
          last_used_at?: string | null
          name?: string
          rate_limits?: Json | null
          status?: string
          updated_at?: string | null
          user_id: string
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          key_type?: string
          last_used_at?: string | null
          name?: string
          rate_limits?: Json | null
          status?: string
          updated_at?: string | null
          user_id?: string
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      api_logs: {
        Row: {
          api_key_id: string | null
          created_at: string | null
          endpoint: string
          error_message: string | null
          id: string
          ip_address: string | null
          method: string
          response_time_ms: number | null
          status_code: number
          user_id: string | null
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string | null
          endpoint: string
          error_message?: string | null
          id?: string
          ip_address?: string | null
          method: string
          response_time_ms?: number | null
          status_code: number
          user_id?: string | null
        }
        Update: {
          api_key_id?: string | null
          created_at?: string | null
          endpoint?: string
          error_message?: string | null
          id?: string
          ip_address?: string | null
          method?: string
          response_time_ms?: number | null
          status_code?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_logs_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      archived_shop_financial_records: {
        Row: {
          archived_at: string
          id: string
          owner_id: string
          record: Json
          shop_id: string | null
          source_table: string
          wallet_id: string | null
        }
        Insert: {
          archived_at?: string
          id?: string
          owner_id: string
          record: Json
          shop_id?: string | null
          source_table: string
          wallet_id?: string | null
        }
        Update: {
          archived_at?: string
          id?: string
          owner_id?: string
          record?: Json
          shop_id?: string | null
          source_table?: string
          wallet_id?: string | null
        }
        Relationships: []
      }
      atishare_console_manual_sends: {
        Row: {
          admin_id: string
          bundle_mb: number
          client_reference: string
          created_at: string
          id: string
          phone: string
          response: Json | null
          status: string
          transaction_id: string | null
        }
        Insert: {
          admin_id: string
          bundle_mb: number
          client_reference: string
          created_at?: string
          id?: string
          phone: string
          response?: Json | null
          status?: string
          transaction_id?: string | null
        }
        Update: {
          admin_id?: string
          bundle_mb?: number
          client_reference?: string
          created_at?: string
          id?: string
          phone?: string
          response?: Json | null
          status?: string
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "atishare_console_manual_sends_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_wallet_transactions: {
        Row: {
          account_name: string | null
          admin_note: string | null
          airtime_order_id: string | null
          amount: number
          commission_wallet_id: string
          created_at: string
          description: string | null
          failure_reason: string | null
          fee: number | null
          id: string
          last_polled_at: string | null
          momo_number: string | null
          name_verified: boolean | null
          net_amount: number | null
          network: string | null
          order_reference: string | null
          order_table: string | null
          payout_provider: string | null
          paystack_fee: number | null
          paystack_recipient_code: string | null
          paystack_transfer_code: string | null
          paystack_transfer_reference: string | null
          paystack_transfer_status: string | null
          poll_attempts: number
          processed_at: string | null
          processed_by: string | null
          status: string
          type: string
          updated_at: string
          utility_order_id: string | null
        }
        Insert: {
          account_name?: string | null
          admin_note?: string | null
          airtime_order_id?: string | null
          amount: number
          commission_wallet_id: string
          created_at?: string
          description?: string | null
          failure_reason?: string | null
          fee?: number | null
          id?: string
          last_polled_at?: string | null
          momo_number?: string | null
          name_verified?: boolean | null
          net_amount?: number | null
          network?: string | null
          order_reference?: string | null
          order_table?: string | null
          payout_provider?: string | null
          paystack_fee?: number | null
          paystack_recipient_code?: string | null
          paystack_transfer_code?: string | null
          paystack_transfer_reference?: string | null
          paystack_transfer_status?: string | null
          poll_attempts?: number
          processed_at?: string | null
          processed_by?: string | null
          status?: string
          type: string
          updated_at?: string
          utility_order_id?: string | null
        }
        Update: {
          account_name?: string | null
          admin_note?: string | null
          airtime_order_id?: string | null
          amount?: number
          commission_wallet_id?: string
          created_at?: string
          description?: string | null
          failure_reason?: string | null
          fee?: number | null
          id?: string
          last_polled_at?: string | null
          momo_number?: string | null
          name_verified?: boolean | null
          net_amount?: number | null
          network?: string | null
          order_reference?: string | null
          order_table?: string | null
          payout_provider?: string | null
          paystack_fee?: number | null
          paystack_recipient_code?: string | null
          paystack_transfer_code?: string | null
          paystack_transfer_reference?: string | null
          paystack_transfer_status?: string | null
          poll_attempts?: number
          processed_at?: string | null
          processed_by?: string | null
          status?: string
          type?: string
          updated_at?: string
          utility_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commission_wallet_transactions_airtime_order_id_fkey"
            columns: ["airtime_order_id"]
            isOneToOne: false
            referencedRelation: "airtime_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_wallet_transactions_commission_wallet_id_fkey"
            columns: ["commission_wallet_id"]
            isOneToOne: false
            referencedRelation: "commission_wallets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_wallet_transactions_processed_by_fkey"
            columns: ["processed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_wallet_transactions_utility_order_id_fkey"
            columns: ["utility_order_id"]
            isOneToOne: false
            referencedRelation: "utility_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_wallets: {
        Row: {
          balance: number
          created_at: string
          id: string
          owner_id: string
          total_earned: number
          total_withdrawn: number
          updated_at: string
        }
        Insert: {
          balance?: number
          created_at?: string
          id?: string
          owner_id: string
          total_earned?: number
          total_withdrawn?: number
          updated_at?: string
        }
        Update: {
          balance?: number
          created_at?: string
          id?: string
          owner_id?: string
          total_earned?: number
          total_withdrawn?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "commission_wallets_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      complaints: {
        Row: {
          created_at: string | null
          description: string
          evidence: Json | null
          id: string
          order_id: string
          priority: string | null
          resolution_notes: string | null
          status: string | null
          title: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          description: string
          evidence?: Json | null
          id?: string
          order_id: string
          priority?: string | null
          resolution_notes?: string | null
          status?: string | null
          title: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          description?: string
          evidence?: Json | null
          id?: string
          order_id?: string
          priority?: string | null
          resolution_notes?: string | null
          status?: string | null
          title?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "complaints_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
          {
            foreignKeyName: "complaints_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_purchases: {
        Row: {
          customer_phone: string
          first_purchase_at: string | null
          id: string
          last_purchase_at: string | null
          total_purchases: number | null
          total_spent: number | null
          user_id: string
        }
        Insert: {
          customer_phone: string
          first_purchase_at?: string | null
          id?: string
          last_purchase_at?: string | null
          total_purchases?: number | null
          total_spent?: number | null
          user_id: string
        }
        Update: {
          customer_phone?: string
          first_purchase_at?: string | null
          id?: string
          last_purchase_at?: string | null
          total_purchases?: number | null
          total_spent?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_purchases_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      data_packages: {
        Row: {
          agent_price: number | null
          category: string
          cost_price: number | null
          created_at: string | null
          dealer_price: number | null
          description: string | null
          id: string
          is_available: boolean | null
          network: string
          price: number
          size: string
          sort_order: number | null
          updated_at: string | null
          ussd_enabled: boolean
          ussd_price: number | null
        }
        Insert: {
          agent_price?: number | null
          category?: string
          cost_price?: number | null
          created_at?: string | null
          dealer_price?: number | null
          description?: string | null
          id?: string
          is_available?: boolean | null
          network: string
          price: number
          size: string
          sort_order?: number | null
          updated_at?: string | null
          ussd_enabled?: boolean
          ussd_price?: number | null
        }
        Update: {
          agent_price?: number | null
          category?: string
          cost_price?: number | null
          created_at?: string | null
          dealer_price?: number | null
          description?: string | null
          id?: string
          is_available?: boolean | null
          network?: string
          price?: number
          size?: string
          sort_order?: number | null
          updated_at?: string | null
          ussd_enabled?: boolean
          ussd_price?: number | null
        }
        Relationships: []
      }
      download_batches: {
        Row: {
          created_at: string | null
          filename: string
          id: string
          idempotency_key: string | null
          network: string
          order_count: number
        }
        Insert: {
          created_at?: string | null
          filename: string
          id?: string
          idempotency_key?: string | null
          network: string
          order_count: number
        }
        Update: {
          created_at?: string | null
          filename?: string
          id?: string
          idempotency_key?: string | null
          network?: string
          order_count?: number
        }
        Relationships: []
      }
      fulfillment_logs: {
        Row: {
          api_response: Json | null
          codecraft_reference: string | null
          created_at: string | null
          id: string
          order_id: string
          status: string | null
          updated_at: string | null
        }
        Insert: {
          api_response?: Json | null
          codecraft_reference?: string | null
          created_at?: string | null
          id?: string
          order_id: string
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          api_response?: Json | null
          codecraft_reference?: string | null
          created_at?: string | null
          id?: string
          order_id?: string
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fulfillment_logs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_logs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
        ]
      }
      guest_push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          guest_phone: string | null
          id: string
          p256dh: string
          shop_id: string
          updated_at: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          guest_phone?: string | null
          id?: string
          p256dh: string
          shop_id: string
          updated_at?: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          guest_phone?: string | null
          id?: string
          p256dh?: string
          shop_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_push_subscriptions_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_push_subscriptions_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      hubtel_receive_charges: {
        Row: {
          amount: number
          amount_charged: number | null
          channel: string
          charges: number | null
          created_at: string
          expires_at: string | null
          fees_on_customer: boolean | null
          id: string
          order_id: string | null
          paid_at: string | null
          provider_transaction_id: string | null
          reference_code: string
          service_type: string
          shop_id: string | null
          status: string
        }
        Insert: {
          amount: number
          amount_charged?: number | null
          channel: string
          charges?: number | null
          created_at?: string
          expires_at?: string | null
          fees_on_customer?: boolean | null
          id?: string
          order_id?: string | null
          paid_at?: string | null
          provider_transaction_id?: string | null
          reference_code: string
          service_type: string
          shop_id?: string | null
          status?: string
        }
        Update: {
          amount?: number
          amount_charged?: number | null
          channel?: string
          charges?: number | null
          created_at?: string
          expires_at?: string | null
          fees_on_customer?: boolean | null
          id?: string
          order_id?: string | null
          paid_at?: string | null
          provider_transaction_id?: string | null
          reference_code?: string
          service_type?: string
          shop_id?: string | null
          status?: string
        }
        Relationships: []
      }
      momo_claim_attempts: {
        Row: {
          created_at: string | null
          id: string
          result: string
          transaction_id_input: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          result: string
          transaction_id_input: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          result?: string
          transaction_id_input?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "momo_claim_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      momo_transactions: {
        Row: {
          amount: number
          claim_fee_amount: number | null
          claim_fee_percent: number | null
          claimed_at: string | null
          claimed_by: string | null
          claimed_via_ref: string | null
          created_at: string | null
          id: string
          is_auto_claimed: boolean
          net_amount: number | null
          raw_sms: string | null
          sender_name: string
          sender_network: string
          status: string
          transaction_id: string
        }
        Insert: {
          amount: number
          claim_fee_amount?: number | null
          claim_fee_percent?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          claimed_via_ref?: string | null
          created_at?: string | null
          id?: string
          is_auto_claimed?: boolean
          net_amount?: number | null
          raw_sms?: string | null
          sender_name: string
          sender_network: string
          status?: string
          transaction_id: string
        }
        Update: {
          amount?: number
          claim_fee_amount?: number | null
          claim_fee_percent?: number | null
          claimed_at?: string | null
          claimed_by?: string | null
          claimed_via_ref?: string | null
          created_at?: string | null
          id?: string
          is_auto_claimed?: boolean
          net_amount?: number | null
          raw_sms?: string | null
          sender_name?: string
          sender_network?: string
          status?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "momo_transactions_claimed_by_fkey"
            columns: ["claimed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      mtn_fulfillment_tracking: {
        Row: {
          api_response: Json | null
          created_at: string | null
          id: string
          order_id: string
          retry_count: number | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          api_response?: Json | null
          created_at?: string | null
          id?: string
          order_id: string
          retry_count?: number | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          api_response?: Json | null
          created_at?: string | null
          id?: string
          order_id?: string
          retry_count?: number | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mtn_fulfillment_tracking_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mtn_fulfillment_tracking_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
        ]
      }
      mtn_whitelist_status: {
        Row: {
          checked_at: string
          phone_number: string
          status: string
        }
        Insert: {
          checked_at?: string
          phone_number: string
          status: string
        }
        Update: {
          checked_at?: string
          phone_number?: string
          status?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          action_url: string | null
          created_at: string | null
          id: string
          is_read: boolean | null
          message: string
          title: string
          type: string
          user_id: string
        }
        Insert: {
          action_url?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          message: string
          title: string
          type: string
          user_id: string
        }
        Update: {
          action_url?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          message?: string
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      number_registration_batches: {
        Row: {
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          created_by: string | null
          filename: string
          id: string
          idempotency_key: string | null
          network: string
          number_count: number
          status: string
        }
        Insert: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string | null
          filename: string
          id?: string
          idempotency_key?: string | null
          network?: string
          number_count?: number
          status?: string
        }
        Update: {
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string | null
          filename?: string
          id?: string
          idempotency_key?: string | null
          network?: string
          number_count?: number
          status?: string
        }
        Relationships: []
      }
      number_registrations: {
        Row: {
          batch_id: string | null
          first_seen_at: string
          id: string
          network: string
          phone_number: string
          registered_at: string | null
          source: string
          status: string
          submitted_at: string | null
        }
        Insert: {
          batch_id?: string | null
          first_seen_at?: string
          id?: string
          network?: string
          phone_number: string
          registered_at?: string | null
          source?: string
          status?: string
          submitted_at?: string | null
        }
        Update: {
          batch_id?: string | null
          first_seen_at?: string
          id?: string
          network?: string
          phone_number?: string
          registered_at?: string | null
          source?: string
          status?: string
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "number_registrations_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "number_registration_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      order_retry_attempts: {
        Row: {
          actor_id: string
          actor_role: string
          attempt_no: number
          charged_amount: number
          created_at: string
          error_message: string | null
          funding_wallet_user_id: string | null
          id: string
          mode: string
          new_order_id: string | null
          source_order_id: string
          status: string
          supplier: string | null
          supplier_reference: string | null
        }
        Insert: {
          actor_id: string
          actor_role: string
          attempt_no: number
          charged_amount?: number
          created_at?: string
          error_message?: string | null
          funding_wallet_user_id?: string | null
          id?: string
          mode: string
          new_order_id?: string | null
          source_order_id: string
          status: string
          supplier?: string | null
          supplier_reference?: string | null
        }
        Update: {
          actor_id?: string
          actor_role?: string
          attempt_no?: number
          charged_amount?: number
          created_at?: string
          error_message?: string | null
          funding_wallet_user_id?: string | null
          id?: string
          mode?: string
          new_order_id?: string | null
          source_order_id?: string
          status?: string
          supplier?: string | null
          supplier_reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_retry_attempts_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_retry_attempts_funding_wallet_user_id_fkey"
            columns: ["funding_wallet_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_retry_attempts_new_order_id_fkey"
            columns: ["new_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_retry_attempts_new_order_id_fkey"
            columns: ["new_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
          {
            foreignKeyName: "order_retry_attempts_source_order_id_fkey"
            columns: ["source_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_retry_attempts_source_order_id_fkey"
            columns: ["source_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
        ]
      }
      orders: {
        Row: {
          api_key_id: string | null
          atishare_console_reference: string | null
          atishare_console_transaction_id: string | null
          bundleportal_reference: string | null
          category: string
          codecraft_reference: string | null
          cost_price_at_time: number | null
          created_at: string | null
          dakazina_order_code: string | null
          dakazina_reference: string | null
          dispatch_claimed_at: string | null
          download_batch_id: string | null
          error_message: string | null
          fulfillment_method: string | null
          fulfillment_note: string | null
          ghdata_order_id: string | null
          hendylinks_order_id: string | null
          id: string
          last_retry_at: string | null
          network: string
          payment_method: string | null
          payment_status: string | null
          phone_number: string
          price: number
          reference_code: string
          refund_reason: string | null
          refunded_at: string | null
          refunded_by: string | null
          retried_by: string | null
          retried_by_role: string | null
          retry_count: number
          retry_from_status: string | null
          retry_of_order_id: string | null
          role_at_time: string | null
          self_completed_at: string | null
          self_completed_by: string | null
          self_completed_by_role: string | null
          shop_name: string | null
          shop_order_id: string | null
          size: string
          source: string
          spfastit_reference: string | null
          status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          api_key_id?: string | null
          atishare_console_reference?: string | null
          atishare_console_transaction_id?: string | null
          bundleportal_reference?: string | null
          category?: string
          codecraft_reference?: string | null
          cost_price_at_time?: number | null
          created_at?: string | null
          dakazina_order_code?: string | null
          dakazina_reference?: string | null
          dispatch_claimed_at?: string | null
          download_batch_id?: string | null
          error_message?: string | null
          fulfillment_method?: string | null
          fulfillment_note?: string | null
          ghdata_order_id?: string | null
          hendylinks_order_id?: string | null
          id?: string
          last_retry_at?: string | null
          network: string
          payment_method?: string | null
          payment_status?: string | null
          phone_number: string
          price: number
          reference_code: string
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          retried_by?: string | null
          retried_by_role?: string | null
          retry_count?: number
          retry_from_status?: string | null
          retry_of_order_id?: string | null
          role_at_time?: string | null
          self_completed_at?: string | null
          self_completed_by?: string | null
          self_completed_by_role?: string | null
          shop_name?: string | null
          shop_order_id?: string | null
          size: string
          source?: string
          spfastit_reference?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          api_key_id?: string | null
          atishare_console_reference?: string | null
          atishare_console_transaction_id?: string | null
          bundleportal_reference?: string | null
          category?: string
          codecraft_reference?: string | null
          cost_price_at_time?: number | null
          created_at?: string | null
          dakazina_order_code?: string | null
          dakazina_reference?: string | null
          dispatch_claimed_at?: string | null
          download_batch_id?: string | null
          error_message?: string | null
          fulfillment_method?: string | null
          fulfillment_note?: string | null
          ghdata_order_id?: string | null
          hendylinks_order_id?: string | null
          id?: string
          last_retry_at?: string | null
          network?: string
          payment_method?: string | null
          payment_status?: string | null
          phone_number?: string
          price?: number
          reference_code?: string
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          retried_by?: string | null
          retried_by_role?: string | null
          retry_count?: number
          retry_from_status?: string | null
          retry_of_order_id?: string | null
          role_at_time?: string | null
          self_completed_at?: string | null
          self_completed_by?: string | null
          self_completed_by_role?: string | null
          shop_name?: string | null
          shop_order_id?: string | null
          size?: string
          source?: string
          spfastit_reference?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_download_batch_id_fkey"
            columns: ["download_batch_id"]
            isOneToOne: false
            referencedRelation: "download_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_retried_by_fkey"
            columns: ["retried_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_retry_of_order_id_fkey"
            columns: ["retry_of_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_retry_of_order_id_fkey"
            columns: ["retry_of_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
          {
            foreignKeyName: "orders_self_completed_by_fkey"
            columns: ["self_completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_shop_order_id_fkey"
            columns: ["shop_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_shop_order_id_fkey"
            columns: ["shop_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      passkey_challenges: {
        Row: {
          challenge: string
          created_at: string
          expires_at: string
          flow: string
          id: string
          user_id: string | null
        }
        Insert: {
          challenge: string
          created_at?: string
          expires_at?: string
          flow: string
          id?: string
          user_id?: string | null
        }
        Update: {
          challenge?: string
          created_at?: string
          expires_at?: string
          flow?: string
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      passkey_credentials: {
        Row: {
          backed_up: boolean
          counter: number
          created_at: string
          credential_id: string
          device_type: string | null
          email: string | null
          friendly_name: string
          id: string
          last_used_at: string | null
          public_key: string
          transports: string[] | null
          user_id: string
        }
        Insert: {
          backed_up?: boolean
          counter?: number
          created_at?: string
          credential_id: string
          device_type?: string | null
          email?: string | null
          friendly_name?: string
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string[] | null
          user_id: string
        }
        Update: {
          backed_up?: boolean
          counter?: number
          created_at?: string
          credential_id?: string
          device_type?: string | null
          email?: string | null
          friendly_name?: string
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string[] | null
          user_id?: string
        }
        Relationships: []
      }
      pending_settlements: {
        Row: {
          amount_owed: number
          amount_settled: number
          created_at: string
          id: string
          notes: string | null
          payment_method: string | null
          settled_at: string | null
          status: string
          user_id: string
          wallet_transaction_id: string | null
        }
        Insert: {
          amount_owed: number
          amount_settled?: number
          created_at?: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          settled_at?: string | null
          status?: string
          user_id: string
          wallet_transaction_id?: string | null
        }
        Update: {
          amount_owed?: number
          amount_settled?: number
          created_at?: string
          id?: string
          notes?: string | null
          payment_method?: string | null
          settled_at?: string | null
          status?: string
          user_id?: string
          wallet_transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pending_settlements_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_settlements_wallet_transaction_id_fkey"
            columns: ["wallet_transaction_id"]
            isOneToOne: false
            referencedRelation: "wallet_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_blacklist: {
        Row: {
          created_at: string | null
          id: string
          phone_number: string
          reason: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          phone_number: string
          reason?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          phone_number?: string
          reason?: string | null
        }
        Relationships: []
      }
      phone_otp_verifications: {
        Row: {
          attempts: number | null
          charge_result: Json | null
          code: string
          created_at: string | null
          expires_at: string
          id: string
          pending_charge: Json | null
          phone: string
          used: boolean | null
          verify_reference: string | null
        }
        Insert: {
          attempts?: number | null
          charge_result?: Json | null
          code: string
          created_at?: string | null
          expires_at: string
          id?: string
          pending_charge?: Json | null
          phone: string
          used?: boolean | null
          verify_reference?: string | null
        }
        Update: {
          attempts?: number | null
          charge_result?: Json | null
          code?: string
          created_at?: string | null
          expires_at?: string
          id?: string
          pending_charge?: Json | null
          phone?: string
          used?: boolean | null
          verify_reference?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          updated_at: string
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          updated_at?: string
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      results_checker_complaints: {
        Row: {
          admin_note: string | null
          created_at: string | null
          description: string
          id: string
          order_id: string
          resolved_at: string | null
          shop_id: string | null
          status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          admin_note?: string | null
          created_at?: string | null
          description: string
          id?: string
          order_id: string
          resolved_at?: string | null
          shop_id?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          admin_note?: string | null
          created_at?: string | null
          description?: string
          id?: string
          order_id?: string
          resolved_at?: string | null
          shop_id?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "results_checker_complaints_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "results_checker_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_checker_complaints_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_checker_complaints_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "results_checker_complaints_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      results_checker_inventory: {
        Row: {
          batch_id: string | null
          created_at: string | null
          expiry_date: string | null
          id: string
          pin: string
          reservation_expires_at: string | null
          reserved_by_order: string | null
          serial_number: string
          sold_at: string | null
          sold_to_user_id: string | null
          status: string | null
          type_id: string
          updated_at: string | null
        }
        Insert: {
          batch_id?: string | null
          created_at?: string | null
          expiry_date?: string | null
          id?: string
          pin: string
          reservation_expires_at?: string | null
          reserved_by_order?: string | null
          serial_number: string
          sold_at?: string | null
          sold_to_user_id?: string | null
          status?: string | null
          type_id: string
          updated_at?: string | null
        }
        Update: {
          batch_id?: string | null
          created_at?: string | null
          expiry_date?: string | null
          id?: string
          pin?: string
          reservation_expires_at?: string | null
          reserved_by_order?: string | null
          serial_number?: string
          sold_at?: string | null
          sold_to_user_id?: string | null
          status?: string | null
          type_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "results_checker_inventory_sold_to_user_id_fkey"
            columns: ["sold_to_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_checker_inventory_type_id_fkey"
            columns: ["type_id"]
            isOneToOne: false
            referencedRelation: "results_checker_types"
            referencedColumns: ["id"]
          },
        ]
      }
      results_checker_orders: {
        Row: {
          api_key_id: string | null
          cost_price_at_time: number | null
          created_at: string | null
          customer_email: string | null
          customer_name: string | null
          customer_phone: string | null
          delivered_via: string[] | null
          fee_amount: number | null
          fulfilled_at: string | null
          id: string
          inventory_ids: string[] | null
          merchant_commission: number | null
          payment_method: string | null
          payment_status: string | null
          quantity: number
          reference_code: string | null
          shop_id: string | null
          shop_markup: number | null
          shop_name: string | null
          source: string
          status: string | null
          total_paid: number
          type_id: string | null
          type_name: string | null
          unit_price: number | null
          updated_at: string | null
          user_id: string | null
          user_role: string | null
        }
        Insert: {
          api_key_id?: string | null
          cost_price_at_time?: number | null
          created_at?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          delivered_via?: string[] | null
          fee_amount?: number | null
          fulfilled_at?: string | null
          id?: string
          inventory_ids?: string[] | null
          merchant_commission?: number | null
          payment_method?: string | null
          payment_status?: string | null
          quantity: number
          reference_code?: string | null
          shop_id?: string | null
          shop_markup?: number | null
          shop_name?: string | null
          source?: string
          status?: string | null
          total_paid: number
          type_id?: string | null
          type_name?: string | null
          unit_price?: number | null
          updated_at?: string | null
          user_id?: string | null
          user_role?: string | null
        }
        Update: {
          api_key_id?: string | null
          cost_price_at_time?: number | null
          created_at?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          delivered_via?: string[] | null
          fee_amount?: number | null
          fulfilled_at?: string | null
          id?: string
          inventory_ids?: string[] | null
          merchant_commission?: number | null
          payment_method?: string | null
          payment_status?: string | null
          quantity?: number
          reference_code?: string | null
          shop_id?: string | null
          shop_markup?: number | null
          shop_name?: string | null
          source?: string
          status?: string | null
          total_paid?: number
          type_id?: string | null
          type_name?: string | null
          unit_price?: number | null
          updated_at?: string | null
          user_id?: string | null
          user_role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "results_checker_orders_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_checker_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_checker_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "results_checker_orders_type_id_fkey"
            columns: ["type_id"]
            isOneToOne: false
            referencedRelation: "results_checker_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_checker_orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      results_checker_types: {
        Row: {
          agent_price: number
          bulk_pricing: Json | null
          cost_price: number
          created_at: string | null
          customer_price: number
          dealer_price: number
          display_order: number | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
          ussd_price: number | null
        }
        Insert: {
          agent_price: number
          bulk_pricing?: Json | null
          cost_price: number
          created_at?: string | null
          customer_price: number
          dealer_price?: number
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
          ussd_price?: number | null
        }
        Update: {
          agent_price?: number
          bulk_pricing?: Json | null
          cost_price?: number
          created_at?: string | null
          customer_price?: number
          dealer_price?: number
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
          ussd_price?: number | null
        }
        Relationships: []
      }
      security_events: {
        Row: {
          created_at: string
          detail: Json | null
          event_type: string
          expected_amount: number | null
          guest_phone: string | null
          id: string
          network: string | null
          order_type: string | null
          paid_amount: number | null
          reference: string | null
          shop_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: Json | null
          event_type: string
          expected_amount?: number | null
          guest_phone?: string | null
          id?: string
          network?: string | null
          order_type?: string | null
          paid_amount?: number | null
          reference?: string | null
          shop_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: Json | null
          event_type?: string
          expected_amount?: number | null
          guest_phone?: string | null
          id?: string
          network?: string | null
          order_type?: string | null
          paid_amount?: number | null
          reference?: string | null
          shop_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_events_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_events_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_afa_pending_orders: {
        Row: {
          cost_price: number
          created_at: string
          fulfilled_at: string | null
          guest_email: string | null
          guest_phone: string
          id: string
          order_payload: Json
          paystack_fee: number | null
          paystack_reference: string
          profit: number
          selling_price: number
          shop_id: string
          status: string
        }
        Insert: {
          cost_price: number
          created_at?: string
          fulfilled_at?: string | null
          guest_email?: string | null
          guest_phone: string
          id?: string
          order_payload: Json
          paystack_fee?: number | null
          paystack_reference: string
          profit: number
          selling_price: number
          shop_id: string
          status?: string
        }
        Update: {
          cost_price?: number
          created_at?: string
          fulfilled_at?: string | null
          guest_email?: string | null
          guest_phone?: string
          id?: string
          order_payload?: Json
          paystack_fee?: number | null
          paystack_reference?: string
          profit?: number
          selling_price?: number
          shop_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_afa_pending_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_afa_pending_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_announcements: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          message: string
          shop_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          message: string
          shop_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          message?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_announcements_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_announcements_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_customers: {
        Row: {
          created_at: string
          first_order_at: string | null
          id: string
          last_order_at: string | null
          name: string | null
          notes: string | null
          phone: string
          shop_id: string
          tags: string[]
          total_orders: number
          total_spent: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          first_order_at?: string | null
          id?: string
          last_order_at?: string | null
          name?: string | null
          notes?: string | null
          phone: string
          shop_id: string
          tags?: string[]
          total_orders?: number
          total_spent?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          first_order_at?: string | null
          id?: string
          last_order_at?: string | null
          name?: string | null
          notes?: string | null
          phone?: string
          shop_id?: string
          tags?: string[]
          total_orders?: number
          total_spent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_customers_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_customers_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_global_settings: {
        Row: {
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      shop_invites: {
        Row: {
          code: string
          created_at: string
          expires_at: string | null
          id: string
          max_uses: number | null
          revoked_at: string | null
          shop_id: string
          used_count: number
        }
        Insert: {
          code: string
          created_at?: string
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          revoked_at?: string | null
          shop_id: string
          used_count?: number
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          revoked_at?: string | null
          shop_id?: string
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "shop_invites_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_invites_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_order_splits: {
        Row: {
          beneficiary_shop_id: string
          created_at: string
          id: string
          level: number
          order_id: string
          profit: number
        }
        Insert: {
          beneficiary_shop_id: string
          created_at?: string
          id?: string
          level: number
          order_id: string
          profit: number
        }
        Update: {
          beneficiary_shop_id?: string
          created_at?: string
          id?: string
          level?: number
          order_id?: string
          profit?: number
        }
        Relationships: [
          {
            foreignKeyName: "shop_order_splits_beneficiary_shop_id_fkey"
            columns: ["beneficiary_shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_order_splits_beneficiary_shop_id_fkey"
            columns: ["beneficiary_shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "shop_order_splits_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_order_splits_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_orders: {
        Row: {
          admin_cost_at_time: number | null
          codecraft_reference_id: string | null
          cost_price: number
          created_at: string | null
          dakazina_reference: string | null
          error_message: string | null
          fulfilled_by: string | null
          fulfillment_reference: string | null
          guest_phone: string
          id: string
          network: string
          owner_role_at_time: string | null
          package_id: string | null
          package_size: string
          parent_profit: number | null
          parent_shop_id: string | null
          payer_momo_name: string | null
          payer_momo_network: string | null
          payer_momo_number: string | null
          payer_momo_resolved_at: string | null
          paystack_reference: string | null
          profit: number
          refund_method: string | null
          refund_reason: string | null
          refunded_at: string | null
          refunded_by: string | null
          selling_price: number
          shop_id: string
          source: string
          status: string | null
          updated_at: string | null
        }
        Insert: {
          admin_cost_at_time?: number | null
          codecraft_reference_id?: string | null
          cost_price: number
          created_at?: string | null
          dakazina_reference?: string | null
          error_message?: string | null
          fulfilled_by?: string | null
          fulfillment_reference?: string | null
          guest_phone: string
          id?: string
          network: string
          owner_role_at_time?: string | null
          package_id?: string | null
          package_size: string
          parent_profit?: number | null
          parent_shop_id?: string | null
          payer_momo_name?: string | null
          payer_momo_network?: string | null
          payer_momo_number?: string | null
          payer_momo_resolved_at?: string | null
          paystack_reference?: string | null
          profit: number
          refund_method?: string | null
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          selling_price: number
          shop_id: string
          source?: string
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          admin_cost_at_time?: number | null
          codecraft_reference_id?: string | null
          cost_price?: number
          created_at?: string | null
          dakazina_reference?: string | null
          error_message?: string | null
          fulfilled_by?: string | null
          fulfillment_reference?: string | null
          guest_phone?: string
          id?: string
          network?: string
          owner_role_at_time?: string | null
          package_id?: string | null
          package_size?: string
          parent_profit?: number | null
          parent_shop_id?: string | null
          payer_momo_name?: string | null
          payer_momo_network?: string | null
          payer_momo_number?: string | null
          payer_momo_resolved_at?: string | null
          paystack_reference?: string | null
          profit?: number
          refund_method?: string | null
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          selling_price?: number
          shop_id?: string
          source?: string
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shop_orders_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "data_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_orders_parent_shop_id_fkey"
            columns: ["parent_shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_orders_parent_shop_id_fkey"
            columns: ["parent_shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "shop_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_payment_details: {
        Row: {
          account_name: string
          account_number: string | null
          bank_id: string | null
          bank_name: string | null
          created_at: string
          id: string
          is_default: boolean
          momo_number: string
          network: string
          payment_type: string | null
          shop_owner_id: string
        }
        Insert: {
          account_name: string
          account_number?: string | null
          bank_id?: string | null
          bank_name?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          momo_number: string
          network: string
          payment_type?: string | null
          shop_owner_id: string
        }
        Update: {
          account_name?: string
          account_number?: string | null
          bank_id?: string | null
          bank_name?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          momo_number?: string
          network?: string
          payment_type?: string | null
          shop_owner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_payment_details_shop_owner_id_fkey"
            columns: ["shop_owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_pricing: {
        Row: {
          id: string
          last_auto_updated_at: string | null
          package_id: string
          profit_margin: number
          selling_price: number
          shop_id: string
          sub_price: number | null
        }
        Insert: {
          id?: string
          last_auto_updated_at?: string | null
          package_id: string
          profit_margin?: number
          selling_price: number
          shop_id: string
          sub_price?: number | null
        }
        Update: {
          id?: string
          last_auto_updated_at?: string | null
          package_id?: string
          profit_margin?: number
          selling_price?: number
          shop_id?: string
          sub_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shop_pricing_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "data_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_pricing_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_pricing_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_pricing_logs: {
        Row: {
          changed_at: string | null
          id: string
          new_cost_price: number | null
          new_selling_price: number | null
          old_cost_price: number | null
          old_selling_price: number | null
          package_id: string
          shop_id: string
        }
        Insert: {
          changed_at?: string | null
          id?: string
          new_cost_price?: number | null
          new_selling_price?: number | null
          old_cost_price?: number | null
          old_selling_price?: number | null
          package_id: string
          shop_id: string
        }
        Update: {
          changed_at?: string | null
          id?: string
          new_cost_price?: number | null
          new_selling_price?: number | null
          old_cost_price?: number | null
          old_selling_price?: number | null
          package_id?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_pricing_logs_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "data_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_pricing_logs_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_pricing_logs_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_pricing_pending: {
        Row: {
          id: string
          package_id: string
          selling_price: number
          shop_id: string
          submitted_at: string | null
        }
        Insert: {
          id?: string
          package_id: string
          selling_price: number
          shop_id: string
          submitted_at?: string | null
        }
        Update: {
          id?: string
          package_id?: string
          selling_price?: number
          shop_id?: string
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shop_pricing_pending_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "data_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_pricing_pending_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_pricing_pending_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_profiles: {
        Row: {
          afa_fee_percent: number | null
          afa_selling_price: number | null
          airtime_fee_at: number | null
          airtime_fee_mtn: number | null
          airtime_fee_telecel: number | null
          approval_note: string | null
          approval_status: string | null
          approved_at: string | null
          approved_by: string | null
          banner_pos_x: number | null
          banner_pos_y: number | null
          banner_url: string | null
          banner_zoom: number | null
          brand_accent: string | null
          brand_color: string | null
          community_link: string | null
          created_at: string | null
          description: string | null
          divider_style: string | null
          fulfillment_mode: string | null
          id: string
          is_active: boolean | null
          logo_url: string | null
          mashup_fee_percent: number | null
          min_withdrawal_amount: number | null
          oos_networks: Json
          owner_email: string | null
          owner_id: string
          owner_phone: string | null
          paystack_fee_percent: number | null
          pricing_approved_at: string | null
          pricing_approved_by: string | null
          pricing_note: string | null
          pricing_rejection_acknowledged: boolean | null
          pricing_status: string | null
          pricing_submitted_at: string | null
          results_checker_markup_agent: number | null
          results_checker_markup_customer: number | null
          results_checker_markup_dealer: number
          setup_completed_at: string | null
          setup_progress: Json
          shop_name: string
          shop_slug: string
          sms_order_confirmation_enabled: boolean
          sms_sender_id: string | null
          sms_sender_requested_at: string | null
          sms_sender_reviewed_at: string | null
          sms_sender_status: string | null
          updated_at: string | null
          ussd_activated_at: string | null
          ussd_active: boolean
          ussd_code: string | null
          utilities_enabled: boolean
          utility_sms_confirmation_enabled: boolean
          whatsapp_number: string | null
          withdrawal_fee_flat: number | null
          withdrawal_fee_percent: number | null
        }
        Insert: {
          afa_fee_percent?: number | null
          afa_selling_price?: number | null
          airtime_fee_at?: number | null
          airtime_fee_mtn?: number | null
          airtime_fee_telecel?: number | null
          approval_note?: string | null
          approval_status?: string | null
          approved_at?: string | null
          approved_by?: string | null
          banner_pos_x?: number | null
          banner_pos_y?: number | null
          banner_url?: string | null
          banner_zoom?: number | null
          brand_accent?: string | null
          brand_color?: string | null
          community_link?: string | null
          created_at?: string | null
          description?: string | null
          divider_style?: string | null
          fulfillment_mode?: string | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          mashup_fee_percent?: number | null
          min_withdrawal_amount?: number | null
          oos_networks?: Json
          owner_email?: string | null
          owner_id: string
          owner_phone?: string | null
          paystack_fee_percent?: number | null
          pricing_approved_at?: string | null
          pricing_approved_by?: string | null
          pricing_note?: string | null
          pricing_rejection_acknowledged?: boolean | null
          pricing_status?: string | null
          pricing_submitted_at?: string | null
          results_checker_markup_agent?: number | null
          results_checker_markup_customer?: number | null
          results_checker_markup_dealer?: number
          setup_completed_at?: string | null
          setup_progress?: Json
          shop_name: string
          shop_slug: string
          sms_order_confirmation_enabled?: boolean
          sms_sender_id?: string | null
          sms_sender_requested_at?: string | null
          sms_sender_reviewed_at?: string | null
          sms_sender_status?: string | null
          updated_at?: string | null
          ussd_activated_at?: string | null
          ussd_active?: boolean
          ussd_code?: string | null
          utilities_enabled?: boolean
          utility_sms_confirmation_enabled?: boolean
          whatsapp_number?: string | null
          withdrawal_fee_flat?: number | null
          withdrawal_fee_percent?: number | null
        }
        Update: {
          afa_fee_percent?: number | null
          afa_selling_price?: number | null
          airtime_fee_at?: number | null
          airtime_fee_mtn?: number | null
          airtime_fee_telecel?: number | null
          approval_note?: string | null
          approval_status?: string | null
          approved_at?: string | null
          approved_by?: string | null
          banner_pos_x?: number | null
          banner_pos_y?: number | null
          banner_url?: string | null
          banner_zoom?: number | null
          brand_accent?: string | null
          brand_color?: string | null
          community_link?: string | null
          created_at?: string | null
          description?: string | null
          divider_style?: string | null
          fulfillment_mode?: string | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          mashup_fee_percent?: number | null
          min_withdrawal_amount?: number | null
          oos_networks?: Json
          owner_email?: string | null
          owner_id?: string
          owner_phone?: string | null
          paystack_fee_percent?: number | null
          pricing_approved_at?: string | null
          pricing_approved_by?: string | null
          pricing_note?: string | null
          pricing_rejection_acknowledged?: boolean | null
          pricing_status?: string | null
          pricing_submitted_at?: string | null
          results_checker_markup_agent?: number | null
          results_checker_markup_customer?: number | null
          results_checker_markup_dealer?: number
          setup_completed_at?: string | null
          setup_progress?: Json
          shop_name?: string
          shop_slug?: string
          sms_order_confirmation_enabled?: boolean
          sms_sender_id?: string | null
          sms_sender_requested_at?: string | null
          sms_sender_reviewed_at?: string | null
          sms_sender_status?: string | null
          updated_at?: string | null
          ussd_activated_at?: string | null
          ussd_active?: boolean
          ussd_code?: string | null
          utilities_enabled?: boolean
          utility_sms_confirmation_enabled?: boolean
          whatsapp_number?: string | null
          withdrawal_fee_flat?: number | null
          withdrawal_fee_percent?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shop_profiles_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_profiles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_profiles_pricing_approved_by_fkey"
            columns: ["pricing_approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_rc_markups: {
        Row: {
          created_at: string
          exam_type_id: string
          id: string
          markup: number
          shop_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          exam_type_id: string
          id?: string
          markup?: number
          shop_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          exam_type_id?: string
          id?: string
          markup?: number
          shop_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_rc_markups_exam_type_id_fkey"
            columns: ["exam_type_id"]
            isOneToOne: false
            referencedRelation: "results_checker_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_rc_markups_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_rc_markups_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sender_ids: {
        Row: {
          id: string
          is_default: boolean
          reason: string | null
          requested_at: string
          reviewed_at: string | null
          sender_text: string
          shop_id: string
          status: string
          updated_at: string
        }
        Insert: {
          id?: string
          is_default?: boolean
          reason?: string | null
          requested_at?: string
          reviewed_at?: string | null
          sender_text: string
          shop_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          id?: string
          is_default?: boolean
          reason?: string | null
          requested_at?: string
          reviewed_at?: string | null
          sender_text?: string
          shop_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_sender_ids_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sender_ids_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sms_activations: {
        Row: {
          amount_paid: number
          bonus_claimed: boolean
          bonus_claimed_at: string | null
          created_at: string
          id: string
          owner_id: string
          paid_from: string
          shop_id: string
          sms_suspended: boolean
        }
        Insert: {
          amount_paid: number
          bonus_claimed?: boolean
          bonus_claimed_at?: string | null
          created_at?: string
          id?: string
          owner_id: string
          paid_from: string
          shop_id: string
          sms_suspended?: boolean
        }
        Update: {
          amount_paid?: number
          bonus_claimed?: boolean
          bonus_claimed_at?: string | null
          created_at?: string
          id?: string
          owner_id?: string
          paid_from?: string
          shop_id?: string
          sms_suspended?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_activations_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_activations_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: true
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_activations_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: true
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sms_bundles: {
        Row: {
          created_at: string
          credits: number
          id: string
          is_active: boolean
          name: string
          price: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          credits: number
          id?: string
          is_active?: boolean
          name: string
          price: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          credits?: number
          id?: string
          is_active?: boolean
          name?: string
          price?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      shop_sms_delivery_receipts: {
        Row: {
          created_at: string
          id: string
          log_id: string
          phone: string
          provider_message_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          log_id: string
          phone: string
          provider_message_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          log_id?: string
          phone?: string
          provider_message_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_delivery_receipts_log_id_fkey"
            columns: ["log_id"]
            isOneToOne: false
            referencedRelation: "shop_sms_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_sms_logs: {
        Row: {
          created_at: string
          credits_used: number
          delivered_count: number
          flag_reason: string | null
          flagged: boolean
          id: string
          message: string
          pending_count: number
          provider: string | null
          recipients_count: number
          segments: number
          shop_id: string
          source: string
          status: string
          undelivered_count: number
        }
        Insert: {
          created_at?: string
          credits_used: number
          delivered_count?: number
          flag_reason?: string | null
          flagged?: boolean
          id?: string
          message: string
          pending_count?: number
          provider?: string | null
          recipients_count: number
          segments: number
          shop_id: string
          source?: string
          status?: string
          undelivered_count?: number
        }
        Update: {
          created_at?: string
          credits_used?: number
          delivered_count?: number
          flag_reason?: string | null
          flagged?: boolean
          id?: string
          message?: string
          pending_count?: number
          provider?: string | null
          recipients_count?: number
          segments?: number
          shop_id?: string
          source?: string
          status?: string
          undelivered_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_logs_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_logs_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sms_purchases: {
        Row: {
          bundle_id: string | null
          created_at: string
          credits: number
          id: string
          owner_id: string
          paid_from: string
          price: number
          shop_id: string
        }
        Insert: {
          bundle_id?: string | null
          created_at?: string
          credits: number
          id?: string
          owner_id: string
          paid_from: string
          price: number
          shop_id: string
        }
        Update: {
          bundle_id?: string | null
          created_at?: string
          credits?: number
          id?: string
          owner_id?: string
          paid_from?: string
          price?: number
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_purchases_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "shop_sms_bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_purchases_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_purchases_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_purchases_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sms_refund_failures: {
        Row: {
          created_at: string
          credits: number
          id: string
          reason: string | null
          resolved: boolean
          shop_id: string
        }
        Insert: {
          created_at?: string
          credits: number
          id?: string
          reason?: string | null
          resolved?: boolean
          shop_id: string
        }
        Update: {
          created_at?: string
          credits?: number
          id?: string
          reason?: string | null
          resolved?: boolean
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_refund_failures_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_refund_failures_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sms_send_claims: {
        Row: {
          created_at: string
          id: string
          idempotency_key: string
          shop_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          idempotency_key: string
          shop_id: string
        }
        Update: {
          created_at?: string
          id?: string
          idempotency_key?: string
          shop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_send_claims_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_send_claims_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sms_templates: {
        Row: {
          body: string
          created_at: string
          id: string
          name: string
          shop_id: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          name: string
          shop_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          name?: string
          shop_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_templates_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_templates_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_sms_wallets: {
        Row: {
          credits: number
          shop_id: string
          total_purchased: number
          total_used: number
          updated_at: string
        }
        Insert: {
          credits?: number
          shop_id: string
          total_purchased?: number
          total_used?: number
          updated_at?: string
        }
        Update: {
          credits?: number
          shop_id?: string
          total_purchased?: number
          total_used?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_sms_wallets_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: true
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_sms_wallets_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: true
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      shop_wallet_transactions: {
        Row: {
          account_name: string | null
          account_number: string | null
          admin_note: string | null
          afa_order_id: string | null
          amount: number
          auto_escalated: boolean
          balance_snapshot: number | null
          bank_id: string | null
          bank_name: string | null
          branch: string | null
          created_at: string | null
          created_by: string | null
          credit_source: string | null
          description: string
          escalate_after: string | null
          failure_reason: string | null
          fee: number | null
          id: string
          last_polled_at: string | null
          momo_number: string | null
          moolre_external_ref: string | null
          moolre_status: number | null
          moolre_transaction_id: string | null
          name_verified: boolean | null
          net_amount: number | null
          network: string | null
          order_reference: string | null
          payment_type: string | null
          payout_provider: string | null
          paystack_fee: number | null
          paystack_recipient_code: string | null
          paystack_transfer_code: string | null
          paystack_transfer_reference: string | null
          paystack_transfer_status: string | null
          poll_attempts: number
          processed_at: string | null
          processed_by: string | null
          shop_order_id: string | null
          shop_wallet_id: string
          status: string | null
          sub_approval_note: string | null
          sub_approval_status: string
          sub_approved_by: string | null
          type: string
          updated_at: string | null
          ussd_ref: string | null
          utility_order_id: string | null
        }
        Insert: {
          account_name?: string | null
          account_number?: string | null
          admin_note?: string | null
          afa_order_id?: string | null
          amount: number
          auto_escalated?: boolean
          balance_snapshot?: number | null
          bank_id?: string | null
          bank_name?: string | null
          branch?: string | null
          created_at?: string | null
          created_by?: string | null
          credit_source?: string | null
          description: string
          escalate_after?: string | null
          failure_reason?: string | null
          fee?: number | null
          id?: string
          last_polled_at?: string | null
          momo_number?: string | null
          moolre_external_ref?: string | null
          moolre_status?: number | null
          moolre_transaction_id?: string | null
          name_verified?: boolean | null
          net_amount?: number | null
          network?: string | null
          order_reference?: string | null
          payment_type?: string | null
          payout_provider?: string | null
          paystack_fee?: number | null
          paystack_recipient_code?: string | null
          paystack_transfer_code?: string | null
          paystack_transfer_reference?: string | null
          paystack_transfer_status?: string | null
          poll_attempts?: number
          processed_at?: string | null
          processed_by?: string | null
          shop_order_id?: string | null
          shop_wallet_id: string
          status?: string | null
          sub_approval_note?: string | null
          sub_approval_status?: string
          sub_approved_by?: string | null
          type: string
          updated_at?: string | null
          ussd_ref?: string | null
          utility_order_id?: string | null
        }
        Update: {
          account_name?: string | null
          account_number?: string | null
          admin_note?: string | null
          afa_order_id?: string | null
          amount?: number
          auto_escalated?: boolean
          balance_snapshot?: number | null
          bank_id?: string | null
          bank_name?: string | null
          branch?: string | null
          created_at?: string | null
          created_by?: string | null
          credit_source?: string | null
          description?: string
          escalate_after?: string | null
          failure_reason?: string | null
          fee?: number | null
          id?: string
          last_polled_at?: string | null
          momo_number?: string | null
          moolre_external_ref?: string | null
          moolre_status?: number | null
          moolre_transaction_id?: string | null
          name_verified?: boolean | null
          net_amount?: number | null
          network?: string | null
          order_reference?: string | null
          payment_type?: string | null
          payout_provider?: string | null
          paystack_fee?: number | null
          paystack_recipient_code?: string | null
          paystack_transfer_code?: string | null
          paystack_transfer_reference?: string | null
          paystack_transfer_status?: string | null
          poll_attempts?: number
          processed_at?: string | null
          processed_by?: string | null
          shop_order_id?: string | null
          shop_wallet_id?: string
          status?: string | null
          sub_approval_note?: string | null
          sub_approval_status?: string
          sub_approved_by?: string | null
          type?: string
          updated_at?: string | null
          ussd_ref?: string | null
          utility_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shop_wallet_transactions_afa_order_id_fkey"
            columns: ["afa_order_id"]
            isOneToOne: false
            referencedRelation: "afa_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallet_transactions_processed_by_fkey"
            columns: ["processed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallet_transactions_shop_order_id_fkey"
            columns: ["shop_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallet_transactions_shop_order_id_fkey"
            columns: ["shop_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallet_transactions_shop_wallet_id_fkey"
            columns: ["shop_wallet_id"]
            isOneToOne: false
            referencedRelation: "shop_wallets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallet_transactions_sub_approved_by_fkey"
            columns: ["sub_approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_wallets: {
        Row: {
          balance: number | null
          created_at: string | null
          id: string
          owner_id: string
          total_earned: number | null
          total_withdrawn: number | null
          updated_at: string | null
        }
        Insert: {
          balance?: number | null
          created_at?: string | null
          id?: string
          owner_id: string
          total_earned?: number | null
          total_withdrawn?: number | null
          updated_at?: string | null
        }
        Update: {
          balance?: number | null
          created_at?: string | null
          id?: string
          owner_id?: string
          total_earned?: number | null
          total_withdrawn?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shop_wallets_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_accounts: {
        Row: {
          business_on_hold: boolean
          created_at: string
          default_sender: string | null
          id: string
          low_balance_notified_at: string | null
          low_balance_threshold: number
          mode: string
          status: string
          suspended_reason: string | null
          updated_at: string
          use_own_sender_for_confirmations: boolean
          user_id: string
          webhook_secret: string | null
          webhook_url: string | null
        }
        Insert: {
          business_on_hold?: boolean
          created_at?: string
          default_sender?: string | null
          id?: string
          low_balance_notified_at?: string | null
          low_balance_threshold?: number
          mode?: string
          status?: string
          suspended_reason?: string | null
          updated_at?: string
          use_own_sender_for_confirmations?: boolean
          user_id: string
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Update: {
          business_on_hold?: boolean
          created_at?: string
          default_sender?: string | null
          id?: string
          low_balance_notified_at?: string | null
          low_balance_threshold?: number
          mode?: string
          status?: string
          suspended_reason?: string | null
          updated_at?: string
          use_own_sender_for_confirmations?: boolean
          user_id?: string
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_bundles: {
        Row: {
          business_price: number | null
          credits: number
          id: string
          is_active: boolean
          mode: string
          name: string
          price: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          business_price?: number | null
          credits: number
          id?: string
          is_active?: boolean
          mode?: string
          name: string
          price: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          business_price?: number | null
          credits?: number
          id?: string
          is_active?: boolean
          mode?: string
          name?: string
          price?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      sms_business_profiles: {
        Row: {
          account_id: string
          business_name: string
          contact_whatsapp_number: string | null
          created_at: string
          description: string
          domain_link: string | null
          ghana_card_number_masked: string | null
          id: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          whatsapp_verification_note: string | null
          whatsapp_verified: boolean
        }
        Insert: {
          account_id: string
          business_name: string
          contact_whatsapp_number?: string | null
          created_at?: string
          description: string
          domain_link?: string | null
          ghana_card_number_masked?: string | null
          id?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          whatsapp_verification_note?: string | null
          whatsapp_verified?: boolean
        }
        Update: {
          account_id?: string
          business_name?: string
          contact_whatsapp_number?: string | null
          created_at?: string
          description?: string
          domain_link?: string | null
          ghana_card_number_masked?: string | null
          id?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          whatsapp_verification_note?: string | null
          whatsapp_verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "sms_business_profiles_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_business_profiles_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_campaigns: {
        Row: {
          account_id: string
          claimed_at: string | null
          created_at: string
          credits_charged: number
          flag_reason: string | null
          flag_severity: string | null
          flagged: boolean
          id: string
          message: string
          mode_at_send: string
          provider: string
          recipients_count: number
          scheduled_at: string | null
          segments: number
          sender_used: string | null
          settled_at: string | null
          source: string
          status: string
        }
        Insert: {
          account_id: string
          claimed_at?: string | null
          created_at?: string
          credits_charged?: number
          flag_reason?: string | null
          flag_severity?: string | null
          flagged?: boolean
          id?: string
          message: string
          mode_at_send: string
          provider?: string
          recipients_count: number
          scheduled_at?: string | null
          segments: number
          sender_used?: string | null
          settled_at?: string | null
          source?: string
          status: string
        }
        Update: {
          account_id?: string
          claimed_at?: string | null
          created_at?: string
          credits_charged?: number
          flag_reason?: string | null
          flag_severity?: string | null
          flagged?: boolean
          id?: string
          message?: string
          mode_at_send?: string
          provider?: string
          recipients_count?: number
          scheduled_at?: string | null
          segments?: number
          sender_used?: string | null
          settled_at?: string | null
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_campaigns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_contact_groups: {
        Row: {
          account_id: string
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_contact_groups_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_contacts: {
        Row: {
          created_at: string
          first_name: string | null
          group_id: string
          id: string
          last_name: string | null
          phone_number: string
        }
        Insert: {
          created_at?: string
          first_name?: string | null
          group_id: string
          id?: string
          last_name?: string | null
          phone_number: string
        }
        Update: {
          created_at?: string
          first_name?: string | null
          group_id?: string
          id?: string
          last_name?: string | null
          phone_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_contacts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "sms_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_credit_ledger: {
        Row: {
          account_id: string
          balance_after: number | null
          created_at: string
          delta: number
          id: string
          idempotency_key: string
          kind: string
          reference: string | null
        }
        Insert: {
          account_id: string
          balance_after?: number | null
          created_at?: string
          delta: number
          id?: string
          idempotency_key: string
          kind: string
          reference?: string | null
        }
        Update: {
          account_id?: string
          balance_after?: number | null
          created_at?: string
          delta?: number
          id?: string
          idempotency_key?: string
          kind?: string
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_credit_ledger_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_group_contacts: {
        Row: {
          created_at: string
          first_name: string | null
          group_id: string
          id: string
          last_name: string | null
          phone_number: string
        }
        Insert: {
          created_at?: string
          first_name?: string | null
          group_id: string
          id?: string
          last_name?: string | null
          phone_number: string
        }
        Update: {
          created_at?: string
          first_name?: string | null
          group_id?: string
          id?: string
          last_name?: string | null
          phone_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_group_contacts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "sms_contact_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_groups: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      sms_messages: {
        Row: {
          account_id: string
          campaign_id: string
          chunk_no: number
          created_at: string
          id: string
          network_id: string | null
          provider: string
          provider_message_id: string | null
          rate: number | null
          recipient: string
          status: string
          status_detail: string | null
          status_updated_at: string | null
        }
        Insert: {
          account_id: string
          campaign_id: string
          chunk_no?: number
          created_at?: string
          id?: string
          network_id?: string | null
          provider?: string
          provider_message_id?: string | null
          rate?: number | null
          recipient: string
          status?: string
          status_detail?: string | null
          status_updated_at?: string | null
        }
        Update: {
          account_id?: string
          campaign_id?: string
          chunk_no?: number
          created_at?: string
          id?: string
          network_id?: string | null
          provider?: string
          provider_message_id?: string | null
          rate?: number | null
          recipient?: string
          status?: string
          status_detail?: string | null
          status_updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_messages_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "sms_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_purchases: {
        Row: {
          account_id: string
          bundle_id: string | null
          created_at: string
          credits: number
          id: string
          paid_from: string
          payment_reference: string | null
          price: number
          user_id: string
        }
        Insert: {
          account_id: string
          bundle_id?: string | null
          created_at?: string
          credits: number
          id?: string
          paid_from: string
          payment_reference?: string | null
          price: number
          user_id: string
        }
        Update: {
          account_id?: string
          bundle_id?: string | null
          created_at?: string
          credits?: number
          id?: string
          paid_from?: string
          payment_reference?: string | null
          price?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_purchases_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_purchases_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "sms_bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_purchases_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_sender_ids: {
        Row: {
          account_id: string
          approved_at: string | null
          hubtel_reference: string | null
          id: string
          is_default: boolean
          rejection_reason: string | null
          requested_at: string
          sender_text: string
          status: string
          updated_at: string
        }
        Insert: {
          account_id: string
          approved_at?: string | null
          hubtel_reference?: string | null
          id?: string
          is_default?: boolean
          rejection_reason?: string | null
          requested_at?: string
          sender_text: string
          status?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          approved_at?: string | null
          hubtel_reference?: string | null
          id?: string
          is_default?: boolean
          rejection_reason?: string | null
          requested_at?: string
          sender_text?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_sender_ids_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_templates: {
        Row: {
          body: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      sms_user_templates: {
        Row: {
          account_id: string
          body: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          account_id: string
          body: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          body?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_user_templates_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_wallets: {
        Row: {
          account_id: string
          credits: number
          total_purchased: number
          total_used: number
          updated_at: string
        }
        Insert: {
          account_id: string
          credits?: number
          total_purchased?: number
          total_used?: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          credits?: number
          total_purchased?: number
          total_used?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_wallets_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "sms_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_agent_default_pricing: {
        Row: {
          created_at: string
          id: string
          markup: number
          product_ref: string
          product_type: string
          recruiter_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          markup: number
          product_ref: string
          product_type: string
          recruiter_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          markup?: number
          product_ref?: string
          product_type?: string
          recruiter_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sub_agent_default_pricing_recruiter_id_fkey"
            columns: ["recruiter_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_agent_order_earnings: {
        Row: {
          amount: number
          created_at: string
          credited_at: string | null
          id: string
          order_reference: string
          order_table: string
          recruiter_id: string
          reversed_at: string | null
          status: string
          sub_user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          credited_at?: string | null
          id?: string
          order_reference: string
          order_table: string
          recruiter_id: string
          reversed_at?: string | null
          status?: string
          sub_user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          credited_at?: string | null
          id?: string
          order_reference?: string
          order_table?: string
          recruiter_id?: string
          reversed_at?: string | null
          status?: string
          sub_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sub_agent_order_earnings_recruiter_id_fkey"
            columns: ["recruiter_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_agent_order_earnings_sub_user_id_fkey"
            columns: ["sub_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_agent_pricing: {
        Row: {
          created_at: string
          id: string
          markup: number
          product_ref: string
          product_type: string
          recruiter_id: string
          sub_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          markup: number
          product_ref: string
          product_type: string
          recruiter_id: string
          sub_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          markup?: number
          product_ref?: string
          product_type?: string
          recruiter_id?: string
          sub_user_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sub_agent_pricing_recruiter_id_fkey"
            columns: ["recruiter_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_agent_pricing_sub_user_id_fkey"
            columns: ["sub_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_agents: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          id: string
          joined_via_invite: string | null
          markup_ceiling: number | null
          may_recruit: boolean
          pending_key_expires_at: string | null
          pending_key_hash: string | null
          status: string
          updated_at: string
          upline_shop_id: string | null
          upline_user_id: string | null
          user_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          joined_via_invite?: string | null
          markup_ceiling?: number | null
          may_recruit?: boolean
          pending_key_expires_at?: string | null
          pending_key_hash?: string | null
          status?: string
          updated_at?: string
          upline_shop_id?: string | null
          upline_user_id?: string | null
          user_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          joined_via_invite?: string | null
          markup_ceiling?: number | null
          may_recruit?: boolean
          pending_key_expires_at?: string | null
          pending_key_hash?: string | null
          status?: string
          updated_at?: string
          upline_shop_id?: string | null
          upline_user_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sub_agents_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_agents_joined_via_invite_fkey"
            columns: ["joined_via_invite"]
            isOneToOne: false
            referencedRelation: "shop_invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_agents_upline_shop_id_fkey"
            columns: ["upline_shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_agents_upline_shop_id_fkey"
            columns: ["upline_shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "sub_agents_upline_user_id_fkey"
            columns: ["upline_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_agents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      support_messages: {
        Row: {
          body: string
          created_at: string
          delivered_to_admin_at: string | null
          delivered_to_user_at: string | null
          id: string
          read_by_admin_at: string | null
          read_by_user_at: string | null
          sender_id: string
          sender_role: string
          thread_id: string
        }
        Insert: {
          body: string
          created_at?: string
          delivered_to_admin_at?: string | null
          delivered_to_user_at?: string | null
          id?: string
          read_by_admin_at?: string | null
          read_by_user_at?: string | null
          sender_id: string
          sender_role: string
          thread_id: string
        }
        Update: {
          body?: string
          created_at?: string
          delivered_to_admin_at?: string | null
          delivered_to_user_at?: string | null
          id?: string
          read_by_admin_at?: string | null
          read_by_user_at?: string | null
          sender_id?: string
          sender_role?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "support_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      support_threads: {
        Row: {
          category: string
          closed_at: string | null
          closed_by: string | null
          created_at: string
          id: string
          last_message_at: string
          order_id: string | null
          phone_number: string
          status: string
          subject: string
          updated_at: string
          user_id: string
          whatsapp_number: string
        }
        Insert: {
          category?: string
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          last_message_at?: string
          order_id?: string | null
          phone_number: string
          status?: string
          subject: string
          updated_at?: string
          user_id: string
          whatsapp_number: string
        }
        Update: {
          category?: string
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          id?: string
          last_message_at?: string
          order_id?: string | null
          phone_number?: string
          status?: string
          subject?: string
          updated_at?: string
          user_id?: string
          whatsapp_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_threads_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_threads_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
          {
            foreignKeyName: "support_threads_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      system_announcements: {
        Row: {
          created_at: string
          cta_primary_label: string | null
          cta_primary_url: string | null
          cta_secondary_label: string | null
          cta_secondary_url: string | null
          id: string
          is_active: boolean | null
          message: string
          scheduled_at: string | null
          status: string
          title: string
          updated_at: string
          visible_on: string | null
        }
        Insert: {
          created_at?: string
          cta_primary_label?: string | null
          cta_primary_url?: string | null
          cta_secondary_label?: string | null
          cta_secondary_url?: string | null
          id?: string
          is_active?: boolean | null
          message: string
          scheduled_at?: string | null
          status?: string
          title: string
          updated_at?: string
          visible_on?: string | null
        }
        Update: {
          created_at?: string
          cta_primary_label?: string | null
          cta_primary_url?: string | null
          cta_secondary_label?: string | null
          cta_secondary_url?: string | null
          id?: string
          is_active?: boolean | null
          message?: string
          scheduled_at?: string | null
          status?: string
          title?: string
          updated_at?: string
          visible_on?: string | null
        }
        Relationships: []
      }
      terms_acceptances: {
        Row: {
          accepted_at: string
          id: string
          ip_address: string | null
          user_agent: string | null
          user_id: string
          version: string
        }
        Insert: {
          accepted_at?: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id: string
          version: string
        }
        Update: {
          accepted_at?: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "terms_acceptances_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      terms_versions: {
        Row: {
          changelog: Json
          created_at: string
          created_by: string | null
          effective_date: string
          id: string
          is_current: boolean
          published_at: string | null
          requires_reacceptance: boolean
          sections: Json
          version: string
        }
        Insert: {
          changelog?: Json
          created_at?: string
          created_by?: string | null
          effective_date: string
          id?: string
          is_current?: boolean
          published_at?: string | null
          requires_reacceptance?: boolean
          sections?: Json
          version: string
        }
        Update: {
          changelog?: Json
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          is_current?: boolean
          published_at?: string | null
          requires_reacceptance?: boolean
          sections?: Json
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "terms_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_payment_references: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean
          reference_code: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean
          reference_code: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean
          reference_code?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_payment_references_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          agent_expires_at: string | null
          auto_upgrade_enabled: boolean
          auto_upgrade_plan: string | null
          created_at: string | null
          dealer_expires_at: string | null
          email: string
          first_name: string
          id: string
          last_name: string
          notification_prefs: Json
          order_success_sms_enabled: boolean
          phone_number: string | null
          phone_verified: boolean | null
          pin_attempts: number | null
          pin_hash: string | null
          pin_locked_until: string | null
          pin_reminder: string | null
          pin_salt: string | null
          role: string | null
          signup_promo_shown: boolean
          status: string | null
          suspended_at: string | null
          suspended_by: string | null
          suspended_until: string | null
          suspension_reason: string | null
          terms_accepted_at: string | null
          terms_accepted_version: string | null
          updated_at: string | null
        }
        Insert: {
          agent_expires_at?: string | null
          auto_upgrade_enabled?: boolean
          auto_upgrade_plan?: string | null
          created_at?: string | null
          dealer_expires_at?: string | null
          email: string
          first_name: string
          id: string
          last_name: string
          notification_prefs?: Json
          order_success_sms_enabled?: boolean
          phone_number?: string | null
          phone_verified?: boolean | null
          pin_attempts?: number | null
          pin_hash?: string | null
          pin_locked_until?: string | null
          pin_reminder?: string | null
          pin_salt?: string | null
          role?: string | null
          signup_promo_shown?: boolean
          status?: string | null
          suspended_at?: string | null
          suspended_by?: string | null
          suspended_until?: string | null
          suspension_reason?: string | null
          terms_accepted_at?: string | null
          terms_accepted_version?: string | null
          updated_at?: string | null
        }
        Update: {
          agent_expires_at?: string | null
          auto_upgrade_enabled?: boolean
          auto_upgrade_plan?: string | null
          created_at?: string | null
          dealer_expires_at?: string | null
          email?: string
          first_name?: string
          id?: string
          last_name?: string
          notification_prefs?: Json
          order_success_sms_enabled?: boolean
          phone_number?: string | null
          phone_verified?: boolean | null
          pin_attempts?: number | null
          pin_hash?: string | null
          pin_locked_until?: string | null
          pin_reminder?: string | null
          pin_salt?: string | null
          role?: string | null
          signup_promo_shown?: boolean
          status?: string | null
          suspended_at?: string | null
          suspended_by?: string | null
          suspended_until?: string | null
          suspension_reason?: string | null
          terms_accepted_at?: string | null
          terms_accepted_version?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      ussd_callback_retry_queue: {
        Row: {
          attempts: number
          claimed_at: string | null
          created_at: string
          escalated: boolean
          first_failed_at: string
          hubtel_order_id: string
          id: string
          last_attempt_at: string | null
          metadata: Json | null
          resolved: boolean
          resolved_at: string | null
          service_status: string
          session_id: string
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          escalated?: boolean
          first_failed_at?: string
          hubtel_order_id: string
          id?: string
          last_attempt_at?: string | null
          metadata?: Json | null
          resolved?: boolean
          resolved_at?: string | null
          service_status: string
          session_id: string
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          escalated?: boolean
          first_failed_at?: string
          hubtel_order_id?: string
          id?: string
          last_attempt_at?: string | null
          metadata?: Json | null
          resolved?: boolean
          resolved_at?: string | null
          service_status?: string
          session_id?: string
        }
        Relationships: []
      }
      ussd_customers: {
        Row: {
          first_seen: string
          id: string
          last_seen: string
          last_service: string | null
          mobile: string
          operator: string | null
          total_orders: number
          total_spent: number
        }
        Insert: {
          first_seen?: string
          id?: string
          last_seen?: string
          last_service?: string | null
          mobile: string
          operator?: string | null
          total_orders?: number
          total_spent?: number
        }
        Update: {
          first_seen?: string
          id?: string
          last_seen?: string
          last_service?: string | null
          mobile?: string
          operator?: string | null
          total_orders?: number
          total_spent?: number
        }
        Relationships: []
      }
      ussd_pending_orders: {
        Row: {
          claimed_at: string | null
          created_at: string
          expires_at: string
          fulfilled_at: string | null
          hubtel_order_id: string | null
          id: string
          mobile: string
          operator: string | null
          order_payload: Json
          price: number
          service_type: string
          session_id: string
          shop_id: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          expires_at?: string
          fulfilled_at?: string | null
          hubtel_order_id?: string | null
          id?: string
          mobile: string
          operator?: string | null
          order_payload: Json
          price: number
          service_type: string
          session_id: string
          shop_id?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          expires_at?: string
          fulfilled_at?: string | null
          hubtel_order_id?: string | null
          id?: string
          mobile?: string
          operator?: string | null
          order_payload?: Json
          price?: number
          service_type?: string
          session_id?: string
          shop_id?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ussd_pending_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ussd_pending_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      ussd_refund_queue: {
        Row: {
          amount: number
          created_at: string
          hubtel_order_id: string | null
          id: string
          mobile: string
          order_id: string | null
          payment_method: string
          reason: string | null
          refund_reference: string | null
          refunded_at: string | null
          refunded_by: string | null
          service_type: string
          session_id: string
          status: string
          user_id: string | null
          wallet_debit_reference: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          hubtel_order_id?: string | null
          id?: string
          mobile: string
          order_id?: string | null
          payment_method: string
          reason?: string | null
          refund_reference?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          service_type: string
          session_id: string
          status?: string
          user_id?: string | null
          wallet_debit_reference?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          hubtel_order_id?: string | null
          id?: string
          mobile?: string
          order_id?: string | null
          payment_method?: string
          reason?: string | null
          refund_reference?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          service_type?: string
          session_id?: string
          status?: string
          user_id?: string | null
          wallet_debit_reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ussd_refund_queue_refunded_by_fkey"
            columns: ["refunded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ussd_refund_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ussd_sessions: {
        Row: {
          completed: boolean
          created_at: string
          id: string
          interrupted_at: string | null
          interrupted_state: Json | null
          mobile: string
          operator: string | null
          platform: string
          service_used: string | null
          session_id: string
          steps: number
          updated_at: string
        }
        Insert: {
          completed?: boolean
          created_at?: string
          id?: string
          interrupted_at?: string | null
          interrupted_state?: Json | null
          mobile: string
          operator?: string | null
          platform?: string
          service_used?: string | null
          session_id: string
          steps?: number
          updated_at?: string
        }
        Update: {
          completed?: boolean
          created_at?: string
          id?: string
          interrupted_at?: string | null
          interrupted_state?: Json | null
          mobile?: string
          operator?: string | null
          platform?: string
          service_used?: string | null
          session_id?: string
          steps?: number
          updated_at?: string
        }
        Relationships: []
      }
      utility_orders: {
        Row: {
          account_name: string | null
          account_number: string
          amount: number
          api_key_id: string | null
          biller: string
          commission_amount: number | null
          commission_credited_at: string | null
          created_at: string
          customer_email: string | null
          destination_phone: string | null
          fulfillment_attempts: number
          fulfillment_metadata: Json
          fulfillment_request_id: string | null
          id: string
          lookup_snapshot: Json | null
          partner_commission_amount: number | null
          payer_momo_name: string | null
          payer_momo_network: string | null
          payer_momo_number: string | null
          payer_momo_resolved_at: string | null
          payment_method: string
          payment_reference: string | null
          payment_status: string
          paystack_fee: number | null
          reference_code: string
          refund_reason: string | null
          refunded_at: string | null
          refunded_by: string | null
          shop_id: string | null
          source: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          account_name?: string | null
          account_number: string
          amount: number
          api_key_id?: string | null
          biller: string
          commission_amount?: number | null
          commission_credited_at?: string | null
          created_at?: string
          customer_email?: string | null
          destination_phone?: string | null
          fulfillment_attempts?: number
          fulfillment_metadata?: Json
          fulfillment_request_id?: string | null
          id?: string
          lookup_snapshot?: Json | null
          partner_commission_amount?: number | null
          payer_momo_name?: string | null
          payer_momo_network?: string | null
          payer_momo_number?: string | null
          payer_momo_resolved_at?: string | null
          payment_method: string
          payment_reference?: string | null
          payment_status?: string
          paystack_fee?: number | null
          reference_code: string
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          shop_id?: string | null
          source: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          account_name?: string | null
          account_number?: string
          amount?: number
          api_key_id?: string | null
          biller?: string
          commission_amount?: number | null
          commission_credited_at?: string | null
          created_at?: string
          customer_email?: string | null
          destination_phone?: string | null
          fulfillment_attempts?: number
          fulfillment_metadata?: Json
          fulfillment_request_id?: string | null
          id?: string
          lookup_snapshot?: Json | null
          partner_commission_amount?: number | null
          payer_momo_name?: string | null
          payer_momo_network?: string | null
          payer_momo_number?: string | null
          payer_momo_resolved_at?: string | null
          payment_method?: string
          payment_reference?: string | null
          payment_status?: string
          paystack_fee?: number | null
          reference_code?: string
          refund_reason?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          shop_id?: string | null
          source?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "utility_orders_refunded_by_fkey"
            columns: ["refunded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "utility_orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      utility_refund_queue: {
        Row: {
          amount: number
          biller: string
          created_at: string
          id: string
          momo_number: string | null
          reason: string | null
          refund_reference: string | null
          refunded_at: string | null
          refunded_by: string | null
          shop_id: string | null
          source: string
          status: string
          user_id: string | null
          utility_order_id: string
        }
        Insert: {
          amount: number
          biller: string
          created_at?: string
          id?: string
          momo_number?: string | null
          reason?: string | null
          refund_reference?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          shop_id?: string | null
          source: string
          status?: string
          user_id?: string | null
          utility_order_id: string
        }
        Update: {
          amount?: number
          biller?: string
          created_at?: string
          id?: string
          momo_number?: string | null
          reason?: string | null
          refund_reference?: string | null
          refunded_at?: string | null
          refunded_by?: string | null
          shop_id?: string | null
          source?: string
          status?: string
          user_id?: string | null
          utility_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "utility_refund_queue_refunded_by_fkey"
            columns: ["refunded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_refund_queue_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_refund_queue_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "utility_refund_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_refund_queue_utility_order_id_fkey"
            columns: ["utility_order_id"]
            isOneToOne: false
            referencedRelation: "utility_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      utility_saved_accounts: {
        Row: {
          account_name: string | null
          account_number: string
          biller: string
          created_at: string
          destination_phone: string | null
          id: string
          label: string | null
          last_amount: number | null
          last_paid_at: string | null
          user_id: string
        }
        Insert: {
          account_name?: string | null
          account_number: string
          biller: string
          created_at?: string
          destination_phone?: string | null
          id?: string
          label?: string | null
          last_amount?: number | null
          last_paid_at?: string | null
          user_id: string
        }
        Update: {
          account_name?: string | null
          account_number?: string
          biller?: string
          created_at?: string
          destination_phone?: string | null
          id?: string
          label?: string | null
          last_amount?: number | null
          last_paid_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "utility_saved_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      verified_phone_numbers: {
        Row: {
          first_verified_at: string
          id: string
          phone: string
          verified_via: string
        }
        Insert: {
          first_verified_at?: string
          id?: string
          phone: string
          verified_via?: string
        }
        Update: {
          first_verified_at?: string
          id?: string
          phone?: string
          verified_via?: string
        }
        Relationships: []
      }
      wallet_payments: {
        Row: {
          amount: number
          created_at: string | null
          fee: number | null
          id: string
          metadata: Json | null
          provider: string | null
          provider_reference: string | null
          reference: string
          status: string | null
          total_amount: number
          updated_at: string | null
          user_id: string
          wallet_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          fee?: number | null
          id?: string
          metadata?: Json | null
          provider?: string | null
          provider_reference?: string | null
          reference: string
          status?: string | null
          total_amount: number
          updated_at?: string | null
          user_id: string
          wallet_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          fee?: number | null
          id?: string
          metadata?: Json | null
          provider?: string | null
          provider_reference?: string | null
          reference?: string
          status?: string | null
          total_amount?: number
          updated_at?: string | null
          user_id?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_payments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wallet_payments_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      wallet_transactions: {
        Row: {
          amount: number
          created_at: string | null
          description: string
          id: string
          metadata: Json | null
          reference: string | null
          source: string
          status: string | null
          type: string
          user_id: string
          wallet_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          description: string
          id?: string
          metadata?: Json | null
          reference?: string | null
          source: string
          status?: string | null
          type: string
          user_id: string
          wallet_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          description?: string
          id?: string
          metadata?: Json | null
          reference?: string | null
          source?: string
          status?: string | null
          type?: string
          user_id?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wallet_transactions_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      wallets: {
        Row: {
          balance: number | null
          created_at: string | null
          id: string
          total_credited: number | null
          total_spent: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          balance?: number | null
          created_at?: string | null
          id?: string
          total_credited?: number | null
          total_spent?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          balance?: number | null
          created_at?: string | null
          id?: string
          total_credited?: number | null
          total_spent?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallets_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      website_requests: {
        Row: {
          admin_notes: string | null
          budget_ghs: number | null
          category: string | null
          closed_at: string | null
          closed_outcome: string | null
          contact_phone: string
          contact_whatsapp: string | null
          contacted_at: string | null
          created_at: string
          description: string
          features: Json | null
          id: string
          reference_sites: string | null
          request_type: string
          status: string
          timeline: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_notes?: string | null
          budget_ghs?: number | null
          category?: string | null
          closed_at?: string | null
          closed_outcome?: string | null
          contact_phone: string
          contact_whatsapp?: string | null
          contacted_at?: string | null
          created_at?: string
          description: string
          features?: Json | null
          id?: string
          reference_sites?: string | null
          request_type?: string
          status?: string
          timeline?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_notes?: string | null
          budget_ghs?: number | null
          category?: string | null
          closed_at?: string | null
          closed_outcome?: string | null
          contact_phone?: string
          contact_whatsapp?: string | null
          contacted_at?: string | null
          created_at?: string
          description?: string
          features?: Json | null
          id?: string
          reference_sites?: string | null
          request_type?: string
          status?: string
          timeline?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "website_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      shop_orders_effective: {
        Row: {
          admin_cost_at_time: number | null
          codecraft_reference_id: string | null
          cost_price: number | null
          created_at: string | null
          current_order_id: string | null
          current_refunded_at: string | null
          current_retried_by_role: string | null
          current_retry_count: number | null
          current_retry_from_status: string | null
          current_retry_of_order_id: string | null
          current_self_completed_at: string | null
          current_self_completed_by_role: string | null
          dakazina_reference: string | null
          effective_status: string | null
          error_message: string | null
          fulfilled_by: string | null
          fulfillment_reference: string | null
          guest_phone: string | null
          id: string | null
          mirror_order_id: string | null
          mirror_refunded_at: string | null
          network: string | null
          owner_role_at_time: string | null
          package_id: string | null
          package_size: string | null
          parent_profit: number | null
          parent_shop_id: string | null
          payer_momo_name: string | null
          payer_momo_network: string | null
          payer_momo_number: string | null
          payer_momo_resolved_at: string | null
          paystack_reference: string | null
          profit: number | null
          refund_method: string | null
          refund_reason: string | null
          refunded_at: string | null
          refunded_by: string | null
          retried_by_role: string | null
          retry_count: number | null
          retry_from_status: string | null
          retry_of_order_id: string | null
          selling_price: number | null
          shop_id: string | null
          source: string | null
          status: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_retry_of_order_id_fkey"
            columns: ["retry_of_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_retry_of_order_id_fkey"
            columns: ["retry_of_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["mirror_order_id"]
          },
          {
            foreignKeyName: "shop_orders_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "data_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_orders_parent_shop_id_fkey"
            columns: ["parent_shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_orders_parent_shop_id_fkey"
            columns: ["parent_shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
          {
            foreignKeyName: "shop_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shop_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "v_shop_profit_credit_reconciliation"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      v_shop_profit_credit_reconciliation: {
        Row: {
          amount: number | null
          created_at: string | null
          credit_source: string | null
          expected_amount: number | null
          guest_phone: string | null
          id: string | null
          network: string | null
          order_ref: string | null
          order_status: string | null
          owner_email: string | null
          owner_id: string | null
          owner_name: string | null
          owner_phone: string | null
          package_size: string | null
          risk_reasons: string[] | null
          risk_status: string | null
          shop_id: string | null
          shop_name: string | null
          shop_order_id: string | null
          shop_wallet_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shop_wallet_transactions_shop_order_id_fkey"
            columns: ["shop_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallet_transactions_shop_order_id_fkey"
            columns: ["shop_order_id"]
            isOneToOne: false
            referencedRelation: "shop_orders_effective"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallet_transactions_shop_wallet_id_fkey"
            columns: ["shop_wallet_id"]
            isOneToOne: false
            referencedRelation: "shop_wallets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_wallets_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      activate_shop_sms: {
        Args: { p_owner_id: string; p_paid_from: string }
        Returns: Json
      }
      activate_shop_ussd: {
        Args: { p_code: string; p_owner_id: string; p_paid_from: string }
        Returns: Json
      }
      adjust_shop_pricing_for_role_change: {
        Args: { p_new_role: string; p_old_role: string; p_user_id: string }
        Returns: Json
      }
      admin_adjust_wallet: {
        Args: { p_delta: number; p_description?: string; p_user_id: string }
        Returns: Json
      }
      admin_airtime_stats: {
        Args: {
          p_end?: string
          p_network?: string
          p_start?: string
          p_type?: string
        }
        Returns: {
          admin_markup: number
          airtime_count: number
          completed_count: number
          gross_sales: number
          hubtel_commission: number
          hubtel_count: number
          mashup_count: number
          pending_count: number
          pending_value: number
          shop_profit: number
          total_count: number
          total_volume: number
        }[]
      }
      admin_credit_wallet: {
        Args: { p_amount: number; p_user_id: string }
        Returns: Json
      }
      admin_payment_stats: { Args: { from_ts: string }; Returns: Json }
      admin_search_users: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_role?: string
          p_status?: string
          p_term?: string
        }
        Returns: {
          agent_expires_at: string
          created_at: string
          dealer_expires_at: string
          email: string
          first_name: string
          id: string
          last_name: string
          phone_number: string
          phone_verified: boolean
          role: string
          status: string
          suspended_until: string
          suspension_reason: string
          total_count: number
          updated_at: string
          wallet_balance: number
        }[]
      }
      admin_update_subagent_contact: {
        Args: { p_new_email: string; p_new_phone: string; p_user_id: string }
        Returns: undefined
      }
      admin_user_stats: { Args: never; Returns: Json }
      apply_shop_sms_delivery_report: {
        Args: {
          p_detail?: string
          p_provider_message_id: string
          p_status: string
        }
        Returns: Json
      }
      apply_sms_delivery_report: {
        Args: {
          p_detail?: string
          p_provider_message_id: string
          p_status: string
        }
        Returns: Json
      }
      apply_sub_agent_earning_sync: {
        Args: {
          p_new_status: string
          p_order_reference: string
          p_order_table: string
        }
        Returns: undefined
      }
      assign_results_checker_vouchers: {
        Args: { p_order_id: string; p_quantity: number; p_type_id: string }
        Returns: {
          id: string
          pin: string
          serial_number: string
        }[]
      }
      bulk_update_sms_message_status: {
        Args: { p_updates: Json }
        Returns: number
      }
      bump_otp_attempts: {
        Args: { p_id: string }
        Returns: {
          attempts: number
        }[]
      }
      cancel_sms_campaign: {
        Args: { p_account_id: string; p_campaign_id: string }
        Returns: Json
      }
      claim_hubtel_receive_paid: {
        Args: { p_reference: string }
        Returns: Json
      }
      claim_momo_transaction: {
        Args: {
          p_is_auto?: boolean
          p_ref_code?: string
          p_transaction_id: string
          p_user_id: string
        }
        Returns: Json
      }
      claim_order_retry: {
        Args: {
          p_actor_id: string
          p_actor_role: string
          p_charge_amount?: number
          p_cost_price?: number
          p_order_id: string
          p_reference_code?: string
        }
        Returns: Json
      }
      claim_self_order_complete: {
        Args: { p_actor_id: string; p_order_id: string }
        Returns: Json
      }
      claim_sms_campaigns: {
        Args: { p_limit?: number; p_stale_minutes?: number }
        Returns: {
          account_id: string
          claimed_at: string | null
          created_at: string
          credits_charged: number
          flag_reason: string | null
          flag_severity: string | null
          flagged: boolean
          id: string
          message: string
          mode_at_send: string
          provider: string
          recipients_count: number
          scheduled_at: string | null
          segments: number
          sender_used: string | null
          settled_at: string | null
          source: string
          status: string
        }[]
        SetofOptions: {
          from: "*"
          to: "sms_campaigns"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_sms_welcome_bonus: { Args: { p_shop_id: string }; Returns: Json }
      claim_ussd_callback_retry: {
        Args: { p_id: string; p_stale_after_seconds?: number }
        Returns: {
          attempts: number
          claimed_at: string | null
          created_at: string
          escalated: boolean
          first_failed_at: string
          hubtel_order_id: string
          id: string
          last_attempt_at: string | null
          metadata: Json | null
          resolved: boolean
          resolved_at: string | null
          service_status: string
          session_id: string
        }
        SetofOptions: {
          from: "*"
          to: "ussd_callback_retry_queue"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_sms_campaign: {
        Args: {
          p_blocked?: boolean
          p_campaign_id: string
          p_claim_now?: boolean
          p_credits: number
          p_flag_reason?: string
          p_flag_severity?: string
          p_flagged?: boolean
          p_message: string
          p_mode: string
          p_recipients_count: number
          p_scheduled_at?: string
          p_segments: number
          p_sender: string
          p_source?: string
          p_user_id: string
        }
        Returns: Json
      }
      credit_airtime_commission: {
        Args: { p_airtime_order_id: string }
        Returns: Json
      }
      credit_commission_wallet: {
        Args: { p_utility_order_id: string }
        Returns: Json
      }
      credit_lead_margin: {
        Args: {
          p_amount: number
          p_description?: string
          p_order_reference: string
          p_upline_shop_id: string
        }
        Returns: Json
      }
      credit_shop_afa_profit: {
        Args: { p_afa_order_id: string }
        Returns: Json
      }
      credit_shop_order_profits: {
        Args: { p_shop_order_id: string }
        Returns: Json
      }
      credit_shop_profit: { Args: { p_shop_order_id: string }; Returns: Json }
      credit_shop_ussd_profit: {
        Args: {
          p_description: string
          p_profit: number
          p_shop_id: string
          p_ussd_ref: string
        }
        Returns: Json
      }
      credit_sms_credits: {
        Args: { p_credits: number; p_shop_id: string }
        Returns: Json
      }
      credit_user_sms_credits: {
        Args: {
          p_account_id: string
          p_credits: number
          p_key: string
          p_kind?: string
          p_reference?: string
        }
        Returns: Json
      }
      credit_utility_commission: {
        Args: { p_utility_order_id: string }
        Returns: Json
      }
      credit_wallet_balance: {
        Args: { p_amount: number; p_user_id: string }
        Returns: {
          new_balance: number
          new_total_spent: number
          wallet_id: string
        }[]
      }
      debit_sms_credits: {
        Args: { p_credits: number; p_shop_id: string }
        Returns: Json
      }
      deduct_wallet_balance: {
        Args: { p_amount: number; p_user_id: string }
        Returns: {
          new_balance: number
          new_total_spent: number
          wallet_id: string
        }[]
      }
      delete_shop_data: { Args: never; Returns: Json }
      effective_owner_cost: {
        Args: {
          p_agent_price: number
          p_dealer_price: number
          p_price: number
          p_role: string
        }
        Returns: number
      }
      ensure_sms_account: { Args: { p_user_id: string }; Returns: Json }
      escalate_stale_sub_withdrawals: { Args: never; Returns: Json }
      expire_stale_hubtel_receive: {
        Args: { p_older_than_minutes?: number }
        Returns: number
      }
      finalize_results_checker_sale: {
        Args: { p_order_id: string; p_user_id: string }
        Returns: number
      }
      find_drifted_shop_pricing: {
        Args: never
        Returns: {
          owner_cost: number
          owner_id: string
          package_id: string
          role: string
          selling_price: number
          shop_id: string
          sub_price: number
        }[]
      }
      get_admin_dashboard_stats: { Args: never; Returns: Json }
      get_admin_dashboard_trends: { Args: { p_range?: string }; Returns: Json }
      get_admin_recent_activity: { Args: { p_limit?: number }; Returns: Json }
      get_my_orders_stats: {
        Args: {
          p_category?: string
          p_date_from: string
          p_date_to: string
          p_network?: string
          p_search?: string
          p_user_id: string
        }
        Returns: {
          completed_count: number
          failed_count: number
          pending_count: number
          processing_count: number
          queued_count: number
          refunded_count: number
          total_amount: number
          total_count: number
          total_data_gb: number
        }[]
      }
      get_profit_summary: {
        Args: {
          p_end_date: string
          p_prev_end_date: string
          p_prev_start_date: string
          p_start_date: string
        }
        Returns: Json
      }
      get_profit_timeseries: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: Json
      }
      get_shop_credit_rollups: { Args: { p_owner_id?: string }; Returns: Json }
      get_shop_orders_by_phone:
        | {
            Args: {
              p_limit_count?: number
              p_phone_number: string
              p_shop_id?: string
            }
            Returns: {
              created_at: string
              guest_phone: string
              id: string
              network: string
              package_size: string
              selling_price: number
              shop_name: string
              shop_slug: string
              status: string
            }[]
          }
        | {
            Args: { limit_count?: number; phone_number: string }
            Returns: {
              created_at: string
              guest_phone: string
              id: string
              network: string
              package_size: string
              selling_price: number
              shop_name: string
              shop_slug: string
              status: string
            }[]
          }
      get_shop_orders_stats: {
        Args: {
          p_date_from?: string
          p_network?: string
          p_search?: string
          p_shop_id: string
          p_source?: string
          p_status?: string
          p_tab?: string
        }
        Returns: {
          completed_count: number
          failed_count: number
          pending_count: number
          processing_count: number
          profit: number
          queued_count: number
          refunded_count: number
          revenue: number
          total_count: number
        }[]
      }
      get_shop_owner_stats: { Args: never; Returns: Json }
      get_shop_voucher_stats: {
        Args: {
          p_date_from?: string
          p_search?: string
          p_shop_id: string
          p_status?: string
        }
        Returns: {
          completed_count: number
          failed_count: number
          pending_count: number
          processing_count: number
          profit: number
          refunded_count: number
          revenue: number
          total_count: number
        }[]
      }
      get_user_dashboard_stats: { Args: { p_user_id: string }; Returns: Json }
      get_user_transactions_with_balance: {
        Args: {
          p_end_date?: string
          p_limit: number
          p_offset: number
          p_source_filter?: string
          p_start_date?: string
          p_type_filter?: string
          p_user_id: string
        }
        Returns: {
          amount: number
          balance_after: number
          balance_before: number
          created_at: string
          description: string
          id: string
          reference: string
          source: string
          status: string
          type: string
        }[]
      }
      get_wallet_overview: { Args: never; Returns: Json }
      get_wallet_stats: {
        Args: { role_filter?: string }
        Returns: {
          total_balance: number
          total_credited: number
          total_spent: number
          user_count: number
        }[]
      }
      increment_ussd_session_step: {
        Args: {
          p_mobile: string
          p_operator: string
          p_platform: string
          p_session_id: string
        }
        Returns: undefined
      }
      increment_wallet_total_credited: {
        Args: { p_amount: number; p_user_id: string }
        Returns: undefined
      }
      is_admin: { Args: never; Returns: boolean }
      mark_shop_order_refunded: {
        Args: {
          p_actor_id: string
          p_reason: string
          p_reverse_profit?: boolean
          p_shop_order_id: string
        }
        Returns: Json
      }
      normalize_gh_phone: { Args: { p_phone: string }; Returns: string }
      process_afa_order: {
        Args: {
          p_amount: number
          p_form_data: Json
          p_reference_code: string
          p_user_id: string
        }
        Returns: Json
      }
      process_commission_withdrawal: {
        Args: {
          p_account_name: string
          p_amount: number
          p_description: string
          p_fee: number
          p_momo_number: string
          p_name_verified: boolean
          p_net_amount: number
          p_network: string
          p_owner_id: string
          p_wallet_id: string
        }
        Returns: Json
      }
      process_shop_withdrawal: {
        Args: {
          p_account_name: string
          p_account_number: string
          p_amount: number
          p_bank_id: string
          p_bank_name: string
          p_branch: string
          p_description: string
          p_fee: number
          p_momo_number: string
          p_name_verified?: boolean
          p_net_amount: number
          p_network: string
          p_owner_id?: string
          p_payment_type: string
          p_wallet_id: string
        }
        Returns: Json
      }
      process_ussd_wallet_payment: {
        Args: {
          p_amount: number
          p_description: string
          p_reference: string
          p_user_id: string
        }
        Returns: {
          already_processed: boolean
          new_balance: number
          wallet_id: string
        }[]
      }
      publish_terms_version: {
        Args: {
          p_changelog: Json
          p_created_by: string
          p_effective_date: string
          p_requires: boolean
          p_sections: Json
          p_version: string
        }
        Returns: undefined
      }
      purchase_sms_bundle: {
        Args: { p_bundle_id: string; p_owner_id: string; p_paid_from: string }
        Returns: Json
      }
      purchase_user_sms_credits: {
        Args: {
          p_bundle_id: string
          p_client_key?: string
          p_paid_from: string
          p_payment_reference?: string
          p_user_id: string
          p_verified_amount?: number
        }
        Returns: Json
      }
      purge_old_sms_messages: {
        Args: { p_limit?: number; p_months?: number }
        Returns: number
      }
      redeem_sub_invite: {
        Args: { p_code: string; p_user_id: string }
        Returns: Json
      }
      refund_afa_order_wallet: {
        Args: { p_actor_id: string; p_afa_order_id: string; p_reason?: string }
        Returns: Json
      }
      refund_airtime_wallet: {
        Args: { p_actor_id: string; p_order_id: string; p_reason?: string }
        Returns: Json
      }
      refund_order_wallet: {
        Args: { p_actor_id: string; p_order_id: string; p_reason?: string }
        Returns: Json
      }
      refund_shop_withdrawal: {
        Args: { p_admin_id: string; p_reason: string; p_tx_id: string }
        Returns: Json
      }
      refund_sms_credits: {
        Args: { p_credits: number; p_shop_id: string }
        Returns: Json
      }
      refund_ussd_wallet: {
        Args: {
          p_amount: number
          p_description: string
          p_reference: string
          p_user_id: string
        }
        Returns: Json
      }
      refund_utility_wallet: {
        Args: {
          p_actor_id?: string
          p_reason?: string
          p_utility_order_id: string
        }
        Returns: Json
      }
      register_numbers_manual: {
        Args: { p_actor_id: string; p_phones: string[] }
        Returns: Json
      }
      reject_commission_withdrawal: {
        Args: { p_admin_id: string; p_note: string; p_transaction_id: string }
        Returns: Json
      }
      release_expired_rc_reservations: { Args: never; Returns: number }
      release_registration_batch: {
        Args: { p_actor_id: string; p_batch_id: string }
        Returns: Json
      }
      resolve_sub_withdrawal: {
        Args: {
          p_action: string
          p_actor_id: string
          p_note?: string
          p_tx_id: string
        }
        Returns: Json
      }
      resubmit_withdrawal:
        | {
            Args: {
              p_account_name: string
              p_momo_number: string
              p_network: string
              p_transaction_id: string
            }
            Returns: undefined
          }
        | {
            Args: {
              p_account_name: string
              p_admin_note: string
              p_momo_number: string
              p_network: string
              p_transaction_id: string
            }
            Returns: undefined
          }
      reverse_lead_margin: {
        Args: { p_order_reference?: string; p_shop_order_id?: string }
        Returns: Json
      }
      reverse_shop_afa_profit: {
        Args: { p_afa_order_id: string }
        Returns: Json
      }
      reverse_shop_profit: {
        Args: { p_actor_id: string; p_reason?: string; p_shop_order_id: string }
        Returns: Json
      }
      rotate_shop_invite: {
        Args: { p_actor_id: string; p_shop_id: string }
        Returns: Json
      }
      save_shop_payment_detail_if_under_limit: {
        Args: {
          p_account_name: string
          p_account_number: string
          p_bank_id: string
          p_limit?: number
          p_momo_number: string
          p_network: string
          p_owner_id: string
          p_payment_type: string
        }
        Returns: boolean
      }
      set_sub_agent_state: {
        Args: {
          p_action: string
          p_actor_id: string
          p_ceiling?: number
          p_is_admin?: boolean
          p_sub_user_id: string
        }
        Returns: Json
      }
      settle_afa_refund_to_owner: {
        Args: { p_actor_id: string; p_afa_order_id: string; p_reason?: string }
        Returns: Json
      }
      settle_shop_refund_to_owner: {
        Args: { p_actor_id: string; p_reason?: string; p_shop_order_id: string }
        Returns: Json
      }
      settle_sms_campaign: { Args: { p_campaign_id: string }; Returns: Json }
      shop_sms_usage_breakdown: {
        Args: { p_shop_id: string }
        Returns: {
          credits: number
          source: string
        }[]
      }
      sub_chain_depth_above: { Args: { p_shop_id: string }; Returns: number }
      toggle_fulfillment_supplier_network: {
        Args: { p_enable: boolean; p_network: string; p_supplier_key: string }
        Returns: Json
      }
      transfer_commission_wallet: {
        Args: { p_amount: number; p_destination: string; p_owner_id: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

export type User = Database['public']['Tables']['users']['Row']
export type Wallet = Database['public']['Tables']['wallets']['Row']
export type WalletTransaction = Database['public']['Tables']['wallet_transactions']['Row']
export type WalletPayment = Database['public']['Tables']['wallet_payments']['Row']
export type DataPackage = Database['public']['Tables']['data_packages']['Row']
export type Order = Database['public']['Tables']['orders']['Row']
export type Notification = Database['public']['Tables']['notifications']['Row']
export type Complaint = Database['public']['Tables']['complaints']['Row']
export type AdminSetting = Database['public']['Tables']['admin_settings']['Row']
export type AFAOrder = Database['public']['Tables']['afa_orders']['Row']
export type CustomerPurchase = Database['public']['Tables']['customer_purchases']['Row']
export type DownloadBatch = Database['public']['Tables']['download_batches']['Row']
export type SystemAnnouncement = Database['public']['Tables']['system_announcements']['Row']
export type ShopAnnouncement = Database['public']['Tables']['shop_announcements']['Row']
export type PendingSettlement = Database['public']['Tables']['pending_settlements']['Row']
export type ApiKey = Database['public']['Tables']['api_keys']['Row']
export type ApiLog = Database['public']['Tables']['api_logs']['Row']
