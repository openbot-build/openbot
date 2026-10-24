ALTER TABLE "openbot_members" RENAME COLUMN "policies" TO "policy";--> statement-breakpoint
ALTER TABLE "openbot_roles" RENAME COLUMN "policies" TO "policy";--> statement-breakpoint
ALTER TABLE "openbot_tokens" RENAME COLUMN "policies" TO "policy";--> statement-breakpoint
-- Policies change from lists of permission groups on resource keys to the
-- policies of the ability library. A key such as
-- `openbot.org.{org}.user.{self}.chat` becomes an `Under` test on the path of
-- the resource: `org / <organization> / user / <user> / chat`. `{org}` and
-- `{self}` become the fields `organizationId` and `userId` of the principal.
-- Each permission group becomes an action on one kind of resource.
CREATE TEMPORARY TABLE openbot_tmp_groups (
	permission text PRIMARY KEY,
	kind text NOT NULL,
	action text NOT NULL
);
--> statement-breakpoint
INSERT INTO openbot_tmp_groups (permission, kind, action) VALUES
	('responses.run', 'Chat', 'run'),
	('chats.read', 'Chat', 'read'),
	('chats.write', 'Chat', 'write'),
	('files.read', 'File', 'read'),
	('files.write', 'File', 'write'),
	('requests.resolve', 'Request', 'resolve'),
	('bots.read', 'Bot', 'read'),
	('bots.write', 'Bot', 'write'),
	('bots.delegate', 'Bot', 'delegate'),
	('bots.share', 'Bot', 'share'),
	('triggers.read', 'Trigger', 'read'),
	('triggers.write', 'Trigger', 'write'),
	('channels.read', 'Channel', 'read'),
	('channels.write', 'Channel', 'write'),
	('channels.use', 'Channel', 'use'),
	('channel_identities.read', 'ChannelIdentity', 'read'),
	('channel_identities.write', 'ChannelIdentity', 'write'),
	('connections.read', 'Connection', 'read'),
	('connections.write', 'Connection', 'write'),
	('apps.use', 'App', 'use'),
	('apps.publish', 'App', 'publish'),
	('computers.read', 'Computer', 'read'),
	('computers.write', 'Computer', 'write'),
	('computers.use', 'Computer', 'use'),
	('computer_providers.read', 'ComputerProvider', 'read'),
	('computer_providers.write', 'ComputerProvider', 'write'),
	('computer_providers.use', 'ComputerProvider', 'use'),
	('models.use', 'Model', 'use'),
	('tokens.read', 'Token', 'read'),
	('tokens.write', 'Token', 'write'),
	('organization.read', 'Organization', 'read'),
	('organization.write', 'Organization', 'write'),
	('roles.write', 'Role', 'write'),
	('model_providers.read', 'ModelProvider', 'read'),
	('model_providers.write', 'ModelProvider', 'write'),
	('sso.read', 'Sso', 'read'),
	('sso.write', 'Sso', 'write'),
	('platform.read', 'Platform', 'read'),
	('platform.write', 'Platform', 'write'),
	('members.read', 'Member', 'read'),
	('members.write', 'Member', 'write'),
	('audit_logs.read', 'AuditLog', 'read'),
	('usage.read', 'Usage', 'read'),
	('budgets.read', 'Budget', 'read'),
	('budgets.write', 'Budget', 'write');
--> statement-breakpoint
-- How each kind sits in the tree of keys and paths:
-- `own` kinds are below a user with an ID, `user` kinds are the user key itself,
-- `shared` kinds are below a user or, with no owner, below the organization,
-- `child` kinds are below the organization with an ID, `organization` kinds are
-- the organization key itself, and `platform` is the whole deployment.
CREATE TEMPORARY TABLE openbot_tmp_kinds (
	kind text PRIMARY KEY,
	segment text,
	place text NOT NULL
);
--> statement-breakpoint
INSERT INTO openbot_tmp_kinds (kind, segment, place) VALUES
	('Chat', 'chat', 'own'),
	('File', 'file', 'own'),
	('Request', 'request', 'own'),
	('Connection', 'connection', 'own'),
	('App', 'apps', 'apps'),
	('Token', NULL, 'user'),
	('ChannelIdentity', NULL, 'user'),
	('Bot', 'bot', 'shared'),
	('Trigger', 'trigger', 'shared'),
	('Computer', 'computer', 'shared'),
	('ComputerProvider', 'computer_provider', 'shared'),
	('Channel', 'channel', 'child'),
	('Model', 'model', 'child'),
	('Organization', NULL, 'organization'),
	('Role', NULL, 'organization'),
	('Member', NULL, 'organization'),
	('ModelProvider', NULL, 'organization'),
	('Sso', NULL, 'organization'),
	('AuditLog', NULL, 'organization'),
	('Usage', NULL, 'organization'),
	('Budget', NULL, 'organization'),
	('Platform', NULL, 'platform');
--> statement-breakpoint
-- The parts of a key were URL encoded, with `%2E` for a dot.
CREATE FUNCTION pg_temp.openbot_decode(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	bytes bytea := ''::bytea;
	i integer := 1;
	c text;
BEGIN
	WHILE i <= length(value) LOOP
		c := substr(value, i, 1);
		IF c = '%' AND i + 2 <= length(value) THEN
			bytes := bytes || decode(substr(value, i + 1, 2), 'hex');
			i := i + 3;
		ELSE
			bytes := bytes || convert_to(c, 'UTF8');
			i := i + 1;
		END IF;
	END LOOP;
	RETURN convert_from(bytes, 'UTF8');
END
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.openbot_literal(value text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
	SELECT jsonb_build_object('_tag', 'Literal', 'value', value)
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.openbot_operand(part text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE part
		WHEN '{org}' THEN jsonb_build_object('_tag', 'Principal', 'path', 'organizationId')
		WHEN '{self}' THEN jsonb_build_object('_tag', 'Principal', 'path', 'userId')
		ELSE pg_temp.openbot_literal(pg_temp.openbot_decode(part))
	END
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.openbot_under(prefix jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
	SELECT jsonb_build_object('_tag', 'Under', 'prefix', prefix)
$$;
--> statement-breakpoint
-- The condition of a rule for one kind and one old key. `{}` means a rule with
-- no condition. NULL means that the key never covered this kind, so there is
-- no rule.
CREATE FUNCTION pg_temp.openbot_condition(resource text, kind_place text, kind_segment text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	parts text[] := string_to_array(resource, '.');
	n integer := coalesce(array_length(parts, 1), 0);
	base jsonb;
	owner jsonb;
	no_owner jsonb := jsonb_build_object(
		'_tag', 'Compare', 'op', 'eq', 'field', 'ownerUserId',
		'value', jsonb_build_object('_tag', 'Literal', 'value', NULL)
	);
BEGIN
	IF n < 2 OR parts[1] <> 'openbot' THEN
		RETURN NULL;
	END IF;
	IF parts[2] = 'platform' THEN
		RETURN CASE WHEN n = 2 AND kind_place = 'platform' THEN '{}'::jsonb END;
	END IF;
	IF parts[2] <> 'org' OR n < 3 OR kind_place = 'platform' THEN
		RETURN NULL;
	END IF;
	base := jsonb_build_array(pg_temp.openbot_literal('org'), pg_temp.openbot_operand(parts[3]));
	-- The organization key covers every resource of the organization.
	IF n = 3 THEN
		RETURN pg_temp.openbot_under(base);
	END IF;
	IF parts[4] = 'user' THEN
		IF kind_place NOT IN ('own', 'apps', 'user', 'shared') THEN
			RETURN NULL;
		END IF;
		-- `openbot.org.<org>.user` covers the resources of every user, but not
		-- the shared ones.
		IF n = 4 THEN
			RETURN CASE WHEN kind_place = 'shared' THEN
				jsonb_build_object('_tag', 'And', 'conditions', jsonb_build_array(
					pg_temp.openbot_under(base || jsonb_build_array(pg_temp.openbot_literal('user'))),
					jsonb_build_object('_tag', 'Exists', 'field', 'ownerUserId')
				))
			ELSE pg_temp.openbot_under(base || jsonb_build_array(pg_temp.openbot_literal('user')))
			END;
		END IF;
		owner := base || jsonb_build_array(pg_temp.openbot_literal('user'), pg_temp.openbot_operand(parts[5]));
		IF n = 5 THEN
			RETURN pg_temp.openbot_under(owner);
		END IF;
		IF kind_place = 'user' OR parts[6] <> kind_segment THEN
			RETURN NULL;
		END IF;
		IF n = 6 THEN
			RETURN pg_temp.openbot_under(owner || jsonb_build_array(pg_temp.openbot_literal(kind_segment)));
		END IF;
		IF n = 7 AND kind_place <> 'apps' THEN
			RETURN pg_temp.openbot_under(owner || jsonb_build_array(
				pg_temp.openbot_literal(kind_segment),
				pg_temp.openbot_literal(pg_temp.openbot_decode(parts[7]))
			));
		END IF;
		RETURN NULL;
	END IF;
	IF parts[4] <> kind_segment OR n > 5 THEN
		RETURN NULL;
	END IF;
	-- The shared resources of the organization have no owner.
	IF kind_place = 'shared' THEN
		RETURN jsonb_build_object('_tag', 'And', 'conditions',
			jsonb_build_array(pg_temp.openbot_under(base), no_owner) ||
			CASE WHEN n = 5 THEN jsonb_build_array(jsonb_build_object(
				'_tag', 'Compare', 'op', 'eq', 'field', 'id',
				'value', pg_temp.openbot_literal(pg_temp.openbot_decode(parts[5]))
			)) ELSE '[]'::jsonb END
		);
	END IF;
	IF kind_place = 'child' THEN
		RETURN pg_temp.openbot_under(base || jsonb_build_array(pg_temp.openbot_literal(kind_segment)) ||
			CASE WHEN n = 5 THEN jsonb_build_array(pg_temp.openbot_literal(pg_temp.openbot_decode(parts[5])))
			ELSE '[]'::jsonb END);
	END IF;
	RETURN NULL;
END
$$;
--> statement-breakpoint
-- One list of old policies becomes one policy: a list of rules where a deny
-- rule wins. There is one rule for each old policy, key and kind, with all the
-- actions of that kind.
CREATE FUNCTION pg_temp.openbot_policy(old text) RETURNS text
LANGUAGE sql STABLE AS $$
	SELECT jsonb_build_object(
		'_tag', 'Rules',
		'algorithm', 'denyOverrides',
		'rules', coalesce((
			SELECT jsonb_agg(
				jsonb_build_object(
					'_tag', CASE WHEN rule.effect = 'deny' THEN 'Deny' ELSE 'Allow' END,
					'actions', rule.actions,
					'resources', jsonb_build_array(rule.kind)
				) || CASE WHEN rule.condition = '{}'::jsonb THEN '{}'::jsonb
					ELSE jsonb_build_object('when', rule.condition) END
				ORDER BY rule.policy_place, rule.key_place, rule.kind
			)
			FROM (
				SELECT
					policy.place AS policy_place,
					resource.place AS key_place,
					groups.kind,
					policy.value ->> 'effect' AS effect,
					jsonb_agg(DISTINCT groups.action ORDER BY groups.action) AS actions,
					pg_temp.openbot_condition(resource.key, kinds.place, kinds.segment) AS condition
				FROM jsonb_array_elements(coalesce(old, '[]')::jsonb) WITH ORDINALITY AS policy(value, place)
				CROSS JOIN LATERAL jsonb_array_elements_text(policy.value -> 'permissionGroups') AS permission(id)
				CROSS JOIN LATERAL jsonb_array_elements_text(policy.value -> 'resources') WITH ORDINALITY AS resource(key, place)
				JOIN openbot_tmp_groups AS groups ON groups.permission = permission.id
				JOIN openbot_tmp_kinds AS kinds ON kinds.kind = groups.kind
				GROUP BY policy.place, resource.place, resource.key, groups.kind, kinds.place, kinds.segment, policy.value ->> 'effect'
			) AS rule
			WHERE rule.condition IS NOT NULL
		), '[]'::jsonb)
	)::text
$$;
--> statement-breakpoint
UPDATE openbot_roles SET policy = pg_temp.openbot_policy(policy);
--> statement-breakpoint
UPDATE openbot_members SET policy = pg_temp.openbot_policy(policy);
--> statement-breakpoint
UPDATE openbot_tokens SET policy = pg_temp.openbot_policy(policy);
--> statement-breakpoint
-- The platform settings keep the ceiling. Its field is now `ceiling`.
UPDATE openbot_settings
SET document = (
	((document::jsonb) - 'policyCeiling') ||
	jsonb_build_object('ceiling', pg_temp.openbot_policy(document::jsonb ->> 'policyCeiling')::jsonb)
)::text
WHERE scope_kind = 'platform' AND document::jsonb ? 'policyCeiling';
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_policy(text);
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_condition(text, text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_under(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_operand(text);
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_literal(text);
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_decode(text);
--> statement-breakpoint
DROP TABLE openbot_tmp_kinds;
--> statement-breakpoint
DROP TABLE openbot_tmp_groups;
