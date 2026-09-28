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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          created_at: string
          description: string
          event_type: Database["public"]["Enums"]["activity_event_type"]
          id: string
          metadata: Json | null
          occurred_at: string
          severity: Database["public"]["Enums"]["activity_severity"]
          source: string
          user_id: string
          zone: string | null
        }
        Insert: {
          created_at?: string
          description: string
          event_type: Database["public"]["Enums"]["activity_event_type"]
          id?: string
          metadata?: Json | null
          occurred_at?: string
          severity?: Database["public"]["Enums"]["activity_severity"]
          source: string
          user_id: string
          zone?: string | null
        }
        Update: {
          created_at?: string
          description?: string
          event_type?: Database["public"]["Enums"]["activity_event_type"]
          id?: string
          metadata?: Json | null
          occurred_at?: string
          severity?: Database["public"]["Enums"]["activity_severity"]
          source?: string
          user_id?: string
          zone?: string | null
        }
        Relationships: []
      }
      amazon_order_requests: {
        Row: {
          auto_order: boolean
          axiom_run_id: string | null
          cart_summary: Json | null
          created_at: string
          id: string
          notes: string | null
          search_query: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_order?: boolean
          axiom_run_id?: string | null
          cart_summary?: Json | null
          created_at?: string
          id?: string
          notes?: string | null
          search_query: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_order?: boolean
          axiom_run_id?: string | null
          cart_summary?: Json | null
          created_at?: string
          id?: string
          notes?: string | null
          search_query?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      amazon_settings: {
        Row: {
          amazon_email: string
          configured_by: string
          created_at: string
          encrypted_password: string
          id: string
          updated_at: string
        }
        Insert: {
          amazon_email: string
          configured_by: string
          created_at?: string
          encrypted_password: string
          id?: string
          updated_at?: string
        }
        Update: {
          amazon_email?: string
          configured_by?: string
          created_at?: string
          encrypted_password?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_logs: {
        Row: {
          created_at: string
          email_type: string
          error_message: string | null
          html_body: string
          id: string
          metadata: Json | null
          recipients: string[]
          sent_at: string
          status: string
          subject: string
          text_body: string | null
        }
        Insert: {
          created_at?: string
          email_type?: string
          error_message?: string | null
          html_body: string
          id?: string
          metadata?: Json | null
          recipients: string[]
          sent_at?: string
          status?: string
          subject: string
          text_body?: string | null
        }
        Update: {
          created_at?: string
          email_type?: string
          error_message?: string | null
          html_body?: string
          id?: string
          metadata?: Json | null
          recipients?: string[]
          sent_at?: string
          status?: string
          subject?: string
          text_body?: string | null
        }
        Relationships: []
      }
      entertainment_events: {
        Row: {
          category: string
          created_at: string
          event_date: string
          event_end: string | null
          id: string
          image_url: string | null
          location: string | null
          metadata: Json | null
          season_year: number | null
          source: string
          ticket_url: string | null
          title: string
          updated_at: string
          venue: string | null
        }
        Insert: {
          category: string
          created_at?: string
          event_date: string
          event_end?: string | null
          id?: string
          image_url?: string | null
          location?: string | null
          metadata?: Json | null
          season_year?: number | null
          source?: string
          ticket_url?: string | null
          title: string
          updated_at?: string
          venue?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          event_date?: string
          event_end?: string | null
          id?: string
          image_url?: string | null
          location?: string | null
          metadata?: Json | null
          season_year?: number | null
          source?: string
          ticket_url?: string | null
          title?: string
          updated_at?: string
          venue?: string | null
        }
        Relationships: []
      }
      family_automation_logs: {
        Row: {
          automation_id: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          output: Json | null
          started_at: string
          status: string
        }
        Insert: {
          automation_id: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          output?: Json | null
          started_at?: string
          status?: string
        }
        Update: {
          automation_id?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          output?: Json | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_automation_logs_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "family_automations"
            referencedColumns: ["id"]
          },
        ]
      }
      family_automations: {
        Row: {
          automation_type: string
          config: Json
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          last_run_at: string | null
          name: string
          schedule: string | null
          updated_at: string
        }
        Insert: {
          automation_type?: string
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name: string
          schedule?: string | null
          updated_at?: string
        }
        Update: {
          automation_type?: string
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name?: string
          schedule?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      google_tokens: {
        Row: {
          access_token: string
          created_at: string | null
          google_email: string | null
          id: string
          refresh_token: string
          scopes: string[]
          token_expires_at: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string | null
          google_email?: string | null
          id?: string
          refresh_token: string
          scopes: string[]
          token_expires_at: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string | null
          google_email?: string | null
          id?: string
          refresh_token?: string
          scopes?: string[]
          token_expires_at?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      home_assistant_settings: {
        Row: {
          created_at: string
          encrypted_token: string | null
          ha_url: string | null
          id: string
          is_connected: boolean | null
          last_connected_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_token?: string | null
          ha_url?: string | null
          id?: string
          is_connected?: boolean | null
          last_connected_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_token?: string | null
          ha_url?: string | null
          id?: string
          is_connected?: boolean | null
          last_connected_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      household_members: {
        Row: {
          aliases: string[] | null
          created_at: string | null
          display_name: string
          email: string | null
          id: string
          is_active: boolean
          notion_uuid: string | null
          role: string
          supabase_uuid: string | null
          updated_at: string | null
          whatsapp_number: string | null
        }
        Insert: {
          aliases?: string[] | null
          created_at?: string | null
          display_name: string
          email?: string | null
          id?: string
          is_active?: boolean
          notion_uuid?: string | null
          role?: string
          supabase_uuid?: string | null
          updated_at?: string | null
          whatsapp_number?: string | null
        }
        Update: {
          aliases?: string[] | null
          created_at?: string | null
          display_name?: string
          email?: string | null
          id?: string
          is_active?: boolean
          notion_uuid?: string | null
          role?: string
          supabase_uuid?: string | null
          updated_at?: string | null
          whatsapp_number?: string | null
        }
        Relationships: []
      }
      hw_calendar_config: {
        Row: {
          campus: string
          child_name: string
          created_at: string
          email: string
          grade: number
          id: string
          school_year: string
          synced_at: string | null
        }
        Insert: {
          campus?: string
          child_name: string
          created_at?: string
          email: string
          grade: number
          id?: string
          school_year: string
          synced_at?: string | null
        }
        Update: {
          campus?: string
          child_name?: string
          created_at?: string
          email?: string
          grade?: number
          id?: string
          school_year?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      hw_school_calendars: {
        Row: {
          campus: string
          created_at: string
          events: Json
          id: string
          school_year: string
        }
        Insert: {
          campus?: string
          created_at?: string
          events?: Json
          id?: string
          school_year: string
        }
        Update: {
          campus?: string
          created_at?: string
          events?: Json
          id?: string
          school_year?: string
        }
        Relationships: []
      }
      invited_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          invited_by: string
          phone_number: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          invited_by: string
          phone_number?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          invited_by?: string
          phone_number?: string | null
        }
        Relationships: []
      }
      janus_chat_logs: {
        Row: {
          assistant_response: string | null
          channel: string
          created_at: string
          group_id: string | null
          id: string
          media_type: string | null
          tool_calls: Json | null
          user_display_name: string | null
          user_id: string
          user_message: string
          user_role: string
        }
        Insert: {
          assistant_response?: string | null
          channel?: string
          created_at?: string
          group_id?: string | null
          id?: string
          media_type?: string | null
          tool_calls?: Json | null
          user_display_name?: string | null
          user_id: string
          user_message: string
          user_role?: string
        }
        Update: {
          assistant_response?: string | null
          channel?: string
          created_at?: string
          group_id?: string | null
          id?: string
          media_type?: string | null
          tool_calls?: Json | null
          user_display_name?: string | null
          user_id?: string
          user_message?: string
          user_role?: string
        }
        Relationships: []
      }
      janus_chat_summaries: {
        Row: {
          id: string
          message_count: number
          summary: string
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          message_count?: number
          summary?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          message_count?: number
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      janus_functional_test_logs: {
        Row: {
          created_at: string
          failed: number
          id: string
          overall_status: string
          passed: number
          results: Json
          total_ms: number
        }
        Insert: {
          created_at?: string
          failed?: number
          id?: string
          overall_status?: string
          passed?: number
          results?: Json
          total_ms?: number
        }
        Update: {
          created_at?: string
          failed?: number
          id?: string
          overall_status?: string
          passed?: number
          results?: Json
          total_ms?: number
        }
        Relationships: []
      }
      janus_group_configs: {
        Row: {
          channel: string
          created_at: string
          group_id: string
          group_name: string | null
          id: string
          message_count: number
          notes: string | null
          tier: string
          trusted_phones: string[] | null
          updated_at: string
        }
        Insert: {
          channel?: string
          created_at?: string
          group_id: string
          group_name?: string | null
          id?: string
          message_count?: number
          notes?: string | null
          tier?: string
          trusted_phones?: string[] | null
          updated_at?: string
        }
        Update: {
          channel?: string
          created_at?: string
          group_id?: string
          group_name?: string | null
          id?: string
          message_count?: number
          notes?: string | null
          tier?: string
          trusted_phones?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      janus_health_logs: {
        Row: {
          created_at: string
          id: string
          overall_status: string
          results: Json
          total_ms: number
        }
        Insert: {
          created_at?: string
          id?: string
          overall_status?: string
          results?: Json
          total_ms?: number
        }
        Update: {
          created_at?: string
          id?: string
          overall_status?: string
          results?: Json
          total_ms?: number
        }
        Relationships: []
      }
      janus_memory: {
        Row: {
          context: string | null
          created_at: string | null
          id: string
          key: string
          updated_at: string | null
          user_id: string
          value: string
        }
        Insert: {
          context?: string | null
          created_at?: string | null
          id?: string
          key: string
          updated_at?: string | null
          user_id: string
          value: string
        }
        Update: {
          context?: string | null
          created_at?: string | null
          id?: string
          key?: string
          updated_at?: string | null
          user_id?: string
          value?: string
        }
        Relationships: []
      }
      janus_notifications: {
        Row: {
          delivered_at: string | null
          id: string
          media_url: string | null
          message: string
          seen: boolean | null
          type: string
          user_id: string
        }
        Insert: {
          delivered_at?: string | null
          id?: string
          media_url?: string | null
          message: string
          seen?: boolean | null
          type: string
          user_id: string
        }
        Update: {
          delivered_at?: string | null
          id?: string
          media_url?: string | null
          message?: string
          seen?: boolean | null
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      janus_project_artifacts: {
        Row: {
          artifact_type: string
          content: string
          created_at: string
          id: string
          metadata: Json | null
          project_id: string
          saved_by_display_name: string | null
          saved_by_user_id: string | null
          sort_order: number
          title: string
        }
        Insert: {
          artifact_type?: string
          content?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          project_id: string
          saved_by_display_name?: string | null
          saved_by_user_id?: string | null
          sort_order?: number
          title?: string
        }
        Update: {
          artifact_type?: string
          content?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          project_id?: string
          saved_by_display_name?: string | null
          saved_by_user_id?: string | null
          sort_order?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "janus_project_artifacts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "janus_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      janus_project_shares: {
        Row: {
          created_at: string
          id: string
          project_id: string
          shared_by_user_id: string
          shared_with_user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          shared_by_user_id: string
          shared_with_user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          shared_by_user_id?: string
          shared_with_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "janus_project_shares_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "janus_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      janus_projects: {
        Row: {
          created_at: string
          id: string
          name: string
          notion_page_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          notion_page_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          notion_page_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      janus_reminders: {
        Row: {
          channel: string
          created_at: string | null
          due_at: string
          fired_at: string | null
          id: string
          reminder_text: string
          user_email: string
          user_id: string
          whatsapp_number: string | null
        }
        Insert: {
          channel?: string
          created_at?: string | null
          due_at: string
          fired_at?: string | null
          id?: string
          reminder_text: string
          user_email: string
          user_id: string
          whatsapp_number?: string | null
        }
        Update: {
          channel?: string
          created_at?: string | null
          due_at?: string
          fired_at?: string | null
          id?: string
          reminder_text?: string
          user_email?: string
          user_id?: string
          whatsapp_number?: string | null
        }
        Relationships: []
      }
      media_items: {
        Row: {
          category: string
          created_at: string
          description: string | null
          id: string
          last_fetched_at: string | null
          metadata: Json | null
          poster_url: string | null
          rank: number | null
          rating: string | null
          release_date: string | null
          score: number | null
          source: string
          streaming_platform: string | null
          title: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          description?: string | null
          id?: string
          last_fetched_at?: string | null
          metadata?: Json | null
          poster_url?: string | null
          rank?: number | null
          rating?: string | null
          release_date?: string | null
          score?: number | null
          source?: string
          streaming_platform?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          last_fetched_at?: string | null
          metadata?: Json | null
          poster_url?: string | null
          rank?: number | null
          rating?: string | null
          release_date?: string | null
          score?: number | null
          source?: string
          streaming_platform?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      notion_cached_pages: {
        Row: {
          cached_at: string
          content_preview: string | null
          id: string
          last_edited_at: string | null
          notion_page_id: string
          notion_url: string | null
          properties: Json | null
          sync_config_id: string
          title: string | null
        }
        Insert: {
          cached_at?: string
          content_preview?: string | null
          id?: string
          last_edited_at?: string | null
          notion_page_id: string
          notion_url?: string | null
          properties?: Json | null
          sync_config_id: string
          title?: string | null
        }
        Update: {
          cached_at?: string
          content_preview?: string | null
          id?: string
          last_edited_at?: string | null
          notion_page_id?: string
          notion_url?: string | null
          properties?: Json | null
          sync_config_id?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notion_cached_pages_sync_config_id_fkey"
            columns: ["sync_config_id"]
            isOneToOne: false
            referencedRelation: "notion_sync_config"
            referencedColumns: ["id"]
          },
        ]
      }
      notion_sync_config: {
        Row: {
          created_at: string
          database_name: string | null
          id: string
          is_active: boolean
          last_synced_at: string | null
          notion_database_id: string
          sync_direction: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          database_name?: string | null
          id?: string
          is_active?: boolean
          last_synced_at?: string | null
          notion_database_id: string
          sync_direction?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          database_name?: string | null
          id?: string
          is_active?: boolean
          last_synced_at?: string | null
          notion_database_id?: string
          sync_direction?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notion_webhook_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          notion_database_id: string | null
          notion_page_id: string | null
          payload: Json
          processed: boolean
          processed_at: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          notion_database_id?: string | null
          notion_page_id?: string | null
          payload?: Json
          processed?: boolean
          processed_at?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          notion_database_id?: string | null
          notion_page_id?: string | null
          payload?: Json
          processed?: boolean
          processed_at?: string | null
        }
        Relationships: []
      }
      poi_profiles: {
        Row: {
          created_at: string | null
          id: string
          label: string | null
          last_seen_at: string | null
          organization: string | null
          thumbnail_url: string | null
          updated_at: string | null
          verkada_person_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          label?: string | null
          last_seen_at?: string | null
          organization?: string | null
          thumbnail_url?: string | null
          updated_at?: string | null
          verkada_person_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          label?: string | null
          last_seen_at?: string | null
          organization?: string | null
          thumbnail_url?: string | null
          updated_at?: string | null
          verkada_person_id?: string
        }
        Relationships: []
      }
      poi_sightings: {
        Row: {
          camera_name: string | null
          clip_url: string | null
          confidence: number | null
          created_at: string | null
          id: string
          label: string | null
          organization: string | null
          seen_at: string
          site_name: string | null
          thumbnail_url: string | null
          verkada_person_id: string
        }
        Insert: {
          camera_name?: string | null
          clip_url?: string | null
          confidence?: number | null
          created_at?: string | null
          id?: string
          label?: string | null
          organization?: string | null
          seen_at: string
          site_name?: string | null
          thumbnail_url?: string | null
          verkada_person_id: string
        }
        Update: {
          camera_name?: string | null
          clip_url?: string | null
          confidence?: number | null
          created_at?: string | null
          id?: string
          label?: string | null
          organization?: string | null
          seen_at?: string
          site_name?: string | null
          thumbnail_url?: string | null
          verkada_person_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          approval_status: Database["public"]["Enums"]["approval_status"]
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          phone_number: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          approval_status?: Database["public"]["Enums"]["approval_status"]
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          phone_number?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          approval_status?: Database["public"]["Enums"]["approval_status"]
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          phone_number?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      shopping_cart_items: {
        Row: {
          added_by: string
          created_at: string
          id: string
          notes: string | null
          platform: string
          price: string | null
          product_name: string
          product_url: string | null
          quantity: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          added_by?: string
          created_at?: string
          id?: string
          notes?: string | null
          platform: string
          price?: string | null
          product_name: string
          product_url?: string | null
          quantity?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          added_by?: string
          created_at?: string
          id?: string
          notes?: string | null
          platform?: string
          price?: string | null
          product_name?: string
          product_url?: string | null
          quantity?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      suggestions: {
        Row: {
          admin_note: string | null
          content: string
          created_at: string
          id: string
          status: string
          updated_at: string
          user_display_name: string | null
          user_email: string
          user_id: string
        }
        Insert: {
          admin_note?: string | null
          content: string
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_display_name?: string | null
          user_email: string
          user_id: string
        }
        Update: {
          admin_note?: string | null
          content?: string
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_display_name?: string | null
          user_email?: string
          user_id?: string
        }
        Relationships: []
      }
      system_audit_log: {
        Row: {
          actor_id: string | null
          actor_name: string | null
          actor_role: string | null
          category: string
          channel: string | null
          correlation_id: string | null
          created_at: string
          detail: Json | null
          duration_ms: number | null
          edge_function: string | null
          event_type: string
          id: string
          severity: string
          status: string
          summary: string
        }
        Insert: {
          actor_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          category: string
          channel?: string | null
          correlation_id?: string | null
          created_at?: string
          detail?: Json | null
          duration_ms?: number | null
          edge_function?: string | null
          event_type: string
          id?: string
          severity?: string
          status?: string
          summary: string
        }
        Update: {
          actor_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          category?: string
          channel?: string | null
          correlation_id?: string | null
          created_at?: string
          detail?: Json | null
          duration_ms?: number | null
          edge_function?: string | null
          event_type?: string
          id?: string
          severity?: string
          status?: string
          summary?: string
        }
        Relationships: []
      }
      system_prompts: {
        Row: {
          content: string
          created_at: string
          description: string | null
          id: string
          label: string
          slug: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content?: string
          created_at?: string
          description?: string | null
          id?: string
          label: string
          slug: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          description?: string | null
          id?: string
          label?: string
          slug?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      system_updates: {
        Row: {
          access_hint: string | null
          created_at: string
          description: string
          id: string
          published_at: string
          suggested_by: string | null
          title: string
          update_type: string
          version: string
        }
        Insert: {
          access_hint?: string | null
          created_at?: string
          description?: string
          id?: string
          published_at?: string
          suggested_by?: string | null
          title: string
          update_type?: string
          version: string
        }
        Update: {
          access_hint?: string | null
          created_at?: string
          description?: string
          id?: string
          published_at?: string
          suggested_by?: string | null
          title?: string
          update_type?: string
          version?: string
        }
        Relationships: []
      }
      tesla_activity_logs: {
        Row: {
          created_at: string
          details: Json
          event_type: string
          id: string
          occurred_at: string
          vehicle_id: string
          vehicle_name: string | null
        }
        Insert: {
          created_at?: string
          details?: Json
          event_type: string
          id?: string
          occurred_at?: string
          vehicle_id: string
          vehicle_name?: string | null
        }
        Update: {
          created_at?: string
          details?: Json
          event_type?: string
          id?: string
          occurred_at?: string
          vehicle_id?: string
          vehicle_name?: string | null
        }
        Relationships: []
      }
      tesla_battery_alerts: {
        Row: {
          alert_active: boolean | null
          created_at: string
          id: string
          last_alerted_at: string | null
          last_range_miles: number | null
          last_wa_alerted_range: number | null
          updated_at: string
          vehicle_id: string
          vehicle_name: string | null
        }
        Insert: {
          alert_active?: boolean | null
          created_at?: string
          id?: string
          last_alerted_at?: string | null
          last_range_miles?: number | null
          last_wa_alerted_range?: number | null
          updated_at?: string
          vehicle_id: string
          vehicle_name?: string | null
        }
        Update: {
          alert_active?: boolean | null
          created_at?: string
          id?: string
          last_alerted_at?: string | null
          last_range_miles?: number | null
          last_wa_alerted_range?: number | null
          updated_at?: string
          vehicle_id?: string
          vehicle_name?: string | null
        }
        Relationships: []
      }
      tesla_config: {
        Row: {
          created_at: string
          id: string
          partner_registered: boolean
          private_key_pem: string
          public_key_pem: string
          region: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          partner_registered?: boolean
          private_key_pem: string
          public_key_pem: string
          region?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          partner_registered?: boolean
          private_key_pem?: string
          public_key_pem?: string
          region?: string
          updated_at?: string
        }
        Relationships: []
      }
      tesla_tokens: {
        Row: {
          access_token: string
          created_at: string
          id: string
          refresh_token: string
          token_expires_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string
          id?: string
          refresh_token: string
          token_expires_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string
          id?: string
          refresh_token?: string
          token_expires_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trips: {
        Row: {
          created_at: string
          deleted_at: string | null
          departure_date: string | null
          destination: string | null
          flights: Json | null
          hotels: Json | null
          id: string
          itinerary: Json | null
          last_scanned_at: string | null
          notes: string | null
          return_date: string | null
          source_email_ids: string[] | null
          status: string
          transfers: Json
          travelers: string[] | null
          trip_name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          departure_date?: string | null
          destination?: string | null
          flights?: Json | null
          hotels?: Json | null
          id?: string
          itinerary?: Json | null
          last_scanned_at?: string | null
          notes?: string | null
          return_date?: string | null
          source_email_ids?: string[] | null
          status?: string
          transfers?: Json
          travelers?: string[] | null
          trip_name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          departure_date?: string | null
          destination?: string | null
          flights?: Json | null
          hotels?: Json | null
          id?: string
          itinerary?: Json | null
          last_scanned_at?: string | null
          notes?: string | null
          return_date?: string | null
          source_email_ids?: string[] | null
          status?: string
          transfers?: Json
          travelers?: string[] | null
          trip_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_platform_credentials: {
        Row: {
          created_at: string
          credential_label: string
          encrypted_password: string
          encrypted_username: string
          id: string
          metadata: Json | null
          platform: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credential_label?: string
          encrypted_password: string
          encrypted_username: string
          id?: string
          metadata?: Json | null
          platform: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credential_label?: string
          encrypted_password?: string
          encrypted_username?: string
          id?: string
          metadata?: Json | null
          platform?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      verkada_alert_log: {
        Row: {
          alert_type: string | null
          camera_name: string | null
          created_at: string
          id: string
          sent_at: string
          verkada_alert_id: string
        }
        Insert: {
          alert_type?: string | null
          camera_name?: string | null
          created_at?: string
          id?: string
          sent_at?: string
          verkada_alert_id: string
        }
        Update: {
          alert_type?: string | null
          camera_name?: string | null
          created_at?: string
          id?: string
          sent_at?: string
          verkada_alert_id?: string
        }
        Relationships: []
      }
      whatsapp_dedup: {
        Row: {
          created_at: string
          id: string
          message_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_project_owner: {
        Args: { p_project_id: string; p_user_id: string }
        Returns: boolean
      }
      is_project_shared_with: {
        Args: { p_project_id: string; p_user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      activity_event_type: "motion" | "access" | "alarm" | "camera" | "system"
      activity_severity: "info" | "warning" | "alert"
      app_role: "admin" | "member" | "guest"
      approval_status: "pending" | "approved" | "rejected"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      activity_event_type: ["motion", "access", "alarm", "camera", "system"],
      activity_severity: ["info", "warning", "alert"],
      app_role: ["admin", "member", "guest"],
      approval_status: ["pending", "approved", "rejected"],
    },
  },
} as const
