"""Tenant administration CLI for the WesAI MCP servers.

Requires DATABASE_URL and TENANT_MASTER_KEY in the environment.

Note: the server also auto-migrates on every startup (see
mcp_common.migrate.migrate_on_startup, wired into main.py) — you do NOT
need to run `migrate` manually before deploying. It's kept here for
manual/CI use (e.g. running a migration ahead of a deploy, or in a
`railway run` shell) if you'd rather not wait for a redeploy.

Usage:
    python scripts/tenant_admin.py migrate
    python scripts/tenant_admin.py create-tenant <slug> --name "Shibam Coffee"
    python scripts/tenant_admin.py onboard-link <slug> [--ttl-days 7]
    python scripts/tenant_admin.py mint-key <slug> --scopes read,mutate --label "owner laptop"
    python scripts/tenant_admin.py revoke-key <raw-key>
    python scripts/tenant_admin.py set-credential <slug> <service> --json '{"client_id": "..."}'
    python scripts/tenant_admin.py set-setting <slug> --json '{"business_name": "Shibam Coffee"}'
    python scripts/tenant_admin.py rotate-master-key
    python scripts/tenant_admin.py gen-master-key [--key-id v1]
"""
import argparse
import asyncio
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "mcp-common"))

from mcp_common.crypto import CredentialCipher, generate_master_key
from mcp_common.db import get_pool, close_pool
from mcp_common.migrate import migrate
from mcp_common import store


async def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("migrate")

    c = sub.add_parser("create-tenant"); c.add_argument("slug"); c.add_argument("--name", required=True)
    ol = sub.add_parser("onboard-link"); ol.add_argument("slug")
    ol.add_argument("--ttl-days", type=int, default=7)
    k = sub.add_parser("mint-key"); k.add_argument("slug")
    k.add_argument("--scopes", default="read"); k.add_argument("--label", default="")
    r = sub.add_parser("revoke-key"); r.add_argument("raw_key")
    cr = sub.add_parser("set-credential"); cr.add_argument("slug"); cr.add_argument("service")
    cr.add_argument("--json", dest="payload", required=True)
    st = sub.add_parser("set-setting"); st.add_argument("slug")
    st.add_argument("--json", dest="payload", required=True)
    sub.add_parser("rotate-master-key")
    g = sub.add_parser("gen-master-key"); g.add_argument("--key-id", default="v1")

    args = p.parse_args()

    if args.cmd == "gen-master-key":
        print(generate_master_key(args.key_id))
        return

    try:
        if args.cmd == "migrate":
            await migrate()
        elif args.cmd == "create-tenant":
            tid = await store.create_tenant(args.slug, args.name)
            print(f"Created tenant {args.slug} ({tid})")
        elif args.cmd == "onboard-link":
            import os
            from mcp_common.onboarding.links import mint_link
            raw = await mint_link(args.slug, args.ttl_days)
            base = os.getenv("OAUTH_PUBLIC_URL", "https://<your-domain>").rstrip("/")
            print(f"One-time onboarding link for '{args.slug}' (valid {args.ttl_days} days, shown ONCE):")
            print(f"{base}/onboard?t={raw}")
        elif args.cmd == "mint-key":
            raw = await store.create_api_key(args.slug, args.scopes.split(","), args.label)
            print("API key (shown ONCE, store it now):")
            print(raw)
        elif args.cmd == "revoke-key":
            n = await store.revoke_api_key(args.raw_key)
            print(f"Revoked {n} key(s)")
        elif args.cmd == "set-credential":
            await store.set_credential(args.slug, args.service, json.loads(args.payload), CredentialCipher())
            print(f"Stored encrypted credential {args.slug}/{args.service}")
        elif args.cmd == "set-setting":
            await store.set_settings(args.slug, json.loads(args.payload))
            print(f"Updated settings for {args.slug}")
        elif args.cmd == "rotate-master-key":
            n = await store.reencrypt_all(CredentialCipher())
            print(f"Re-encrypted {n} credential rows with primary key")
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
