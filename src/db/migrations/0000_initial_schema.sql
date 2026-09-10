CREATE TABLE "booster_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"owner_player_id" uuid NOT NULL,
	"obtained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"obtained_source" text NOT NULL,
	"booster_opening_id" uuid,
	CONSTRAINT "card_instances_obtained_source_check" CHECK ("card_instances"."obtained_source" in ('BOOSTER', 'ADMIN'))
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"asset_key" text NOT NULL,
	"rarity" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_rarity_check" CHECK ("cards"."rarity" in ('COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'))
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_discord_user_id_unique" UNIQUE("discord_user_id")
);
--> statement-breakpoint
CREATE TABLE "trade_items" (
	"trade_id" uuid NOT NULL,
	"side" text NOT NULL,
	"card_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "trade_items_trade_id_side_card_id_pk" PRIMARY KEY("trade_id","side","card_id"),
	CONSTRAINT "trade_items_quantity_check" CHECK ("trade_items"."quantity" > 0),
	CONSTRAINT "trade_items_side_check" CHECK ("trade_items"."side" in ('PROPOSER', 'RECIPIENT'))
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposer_player_id" uuid NOT NULL,
	"recipient_player_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "trades_distinct_players_check" CHECK ("trades"."proposer_player_id" <> "trades"."recipient_player_id"),
	CONSTRAINT "trades_status_check" CHECK ("trades"."status" in ('PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED'))
);
--> statement-breakpoint
ALTER TABLE "booster_openings" ADD CONSTRAINT "booster_openings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_instances" ADD CONSTRAINT "card_instances_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_instances" ADD CONSTRAINT "card_instances_owner_player_id_players_id_fk" FOREIGN KEY ("owner_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_instances" ADD CONSTRAINT "card_instances_booster_opening_id_booster_openings_id_fk" FOREIGN KEY ("booster_opening_id") REFERENCES "public"."booster_openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_proposer_player_id_players_id_fk" FOREIGN KEY ("proposer_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_recipient_player_id_players_id_fk" FOREIGN KEY ("recipient_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booster_openings_player_opened_idx" ON "booster_openings" USING btree ("player_id","opened_at");--> statement-breakpoint
CREATE INDEX "card_instances_owner_card_idx" ON "card_instances" USING btree ("owner_player_id","card_id");--> statement-breakpoint
CREATE INDEX "card_instances_card_idx" ON "card_instances" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "trades_recipient_status_created_idx" ON "trades" USING btree ("recipient_player_id","status","created_at");--> statement-breakpoint
CREATE INDEX "trades_proposer_status_created_idx" ON "trades" USING btree ("proposer_player_id","status","created_at");