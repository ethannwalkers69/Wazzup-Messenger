CREATE TABLE IF NOT EXISTS direct_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_one uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 user_two uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (user_one < user_two),
 UNIQUE(user_one,user_two)
);
CREATE TABLE IF NOT EXISTS direct_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
 sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body text,
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 CHECK (body IS NOT NULL AND length(trim(body)) > 0 AND length(body) <= 5000)
);
CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation ON direct_messages(conversation_id,created_at DESC) WHERE deleted_at IS NULL;
