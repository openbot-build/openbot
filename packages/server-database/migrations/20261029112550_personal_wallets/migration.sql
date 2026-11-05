CREATE TABLE "openbot_billing_policy" (
	"id" text PRIMARY KEY,
	"prepaid" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "openbot_credit_grants" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "openbot_organizations" ADD COLUMN "personal_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "openbot_credit_grants" ADD CONSTRAINT "openbot_credit_grants_operation_key_key" UNIQUE("operation_key");--> statement-breakpoint
ALTER TABLE "openbot_organizations" ADD CONSTRAINT "openbot_organizations_personal_owner_user_id_key" UNIQUE("personal_owner_user_id");--> statement-breakpoint
ALTER TABLE "openbot_organizations" ADD CONSTRAINT "openbot_organizations_jCdostMmFu4c_fkey" FOREIGN KEY ("personal_owner_user_id") REFERENCES "openbot_auth_user"("id");
--> statement-breakpoint
CREATE FUNCTION openbot_private_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; target text;
BEGIN
 target := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
 SELECT personal_owner_user_id INTO owner_id FROM openbot_organizations WHERE id = target;
 IF owner_id IS NOT NULL THEN
  IF TG_OP = 'DELETE' OR NEW.user_id <> owner_id OR NEW.roles::jsonb <> '["super_administrator"]'::jsonb OR NEW.status <> 'active' THEN
   RAISE EXCEPTION 'A personal space has one fixed owner';
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER openbot_private_member BEFORE INSERT OR UPDATE OR DELETE ON openbot_members FOR EACH ROW EXECUTE FUNCTION openbot_private_member_guard();
--> statement-breakpoint
CREATE FUNCTION openbot_private_target_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM openbot_organizations WHERE id=NEW.organization_id AND personal_owner_user_id IS NOT NULL) THEN
  RAISE EXCEPTION 'A personal space cannot be shared or use organization SSO';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER openbot_private_invitation BEFORE INSERT OR UPDATE ON openbot_invitations FOR EACH ROW EXECUTE FUNCTION openbot_private_target_guard();
--> statement-breakpoint
CREATE TRIGGER openbot_private_domain BEFORE INSERT OR UPDATE ON openbot_organization_domains FOR EACH ROW EXECUTE FUNCTION openbot_private_target_guard();
--> statement-breakpoint
CREATE TRIGGER openbot_private_sso BEFORE INSERT OR UPDATE ON openbot_sso_connections FOR EACH ROW EXECUTE FUNCTION openbot_private_target_guard();
--> statement-breakpoint
CREATE FUNCTION openbot_credit_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM openbot_billing_policy WHERE id='platform' AND prepaid) THEN NEW.enabled := true; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER openbot_credit_policy BEFORE INSERT OR UPDATE ON openbot_organization_credits FOR EACH ROW EXECUTE FUNCTION openbot_credit_policy_guard();
--> statement-breakpoint
CREATE FUNCTION openbot_new_space_credits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM openbot_billing_policy WHERE id='platform' AND prepaid) THEN
  INSERT INTO openbot_organization_credits(organization_id,enabled,balance_micros,updated_at) VALUES(NEW.id,true,0,NEW.created_at) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER openbot_space_credits AFTER INSERT ON openbot_organizations FOR EACH ROW EXECUTE FUNCTION openbot_new_space_credits();

--> statement-breakpoint
CREATE TRIGGER openbot_private_mapping BEFORE INSERT OR UPDATE ON openbot_mapped_roles FOR EACH ROW EXECUTE FUNCTION openbot_private_target_guard();
