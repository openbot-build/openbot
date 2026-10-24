{
  config,
  pkgs,
  multiverse,
  ...
}:

{
  devenv.warnOnNewVersion = false;

  dotenv = {
    enable = true;
    filename = ".env.development";
  };

  scripts.dev-setup.exec = ''
    set -eu
    umask 077
    mkdir -p .devenv/dev
    if [ ! -f .env.development ]; then
      sed -e "s/^OPENBOT_SECRET_KEYS=$/OPENBOT_SECRET_KEYS=dev:$(openssl rand -hex 32)/" \
        .env.development.example > .env.development
    fi
    if [ ! -f .devenv/dev/cert.pem ] || [ ! -f .devenv/dev/key.pem ]; then
      mkcert -cert-file .devenv/dev/cert.pem -key-file .devenv/dev/key.pem localhost 127.0.0.1 ::1
    fi
    echo "Run mkcert -install, then pnpm dev to sign in with the local development account."
  '';

  tasks."dev:install".exec = "pnpm install --frozen-lockfile";

  processes = {
    # The development database runs in Docker, from the same image as
    # deploy/docker/compose.production.yaml. Its data lives in the Docker
    # volume openbot-dev-postgres.
    postgres.ready.exec = "pg_isready --quiet --host 127.0.0.1 --port \"$OPENBOT_DEV_DATABASE_PORT\"";
    postgres.exec = ''
      set -eu
      docker rm --force openbot-dev-postgres >/dev/null 2>&1 || true
      exec docker run --rm --name openbot-dev-postgres \
        --publish "127.0.0.1:''${OPENBOT_DEV_DATABASE_PORT}:5432" \
        --volume openbot-dev-postgres:/var/lib/postgresql \
        --env POSTGRES_USER=openbot_dev \
        --env POSTGRES_PASSWORD=openbot_dev \
        --env POSTGRES_DB="$OPENBOT_DEV_DATABASE_NAME" \
        postgres:18.6-alpine3.24@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5
    '';
    # The development object storage for files. It speaks the S3 API. Its data
    # lives in .devenv/state/rustfs. The development entry makes the bucket.
    rustfs.ready.exec = "bash -c '</dev/tcp/127.0.0.1/$OPENBOT_DEV_S3_PORT'";
    rustfs.exec = ''
      set -eu
      mkdir -p "$DEVENV_STATE/rustfs"
      exec rustfs server \
        --address "127.0.0.1:''${OPENBOT_DEV_S3_PORT}" \
        --access-key "$OPENBOT_DEV_S3_ACCESS_KEY_ID" \
        --secret-key "$OPENBOT_DEV_S3_SECRET_ACCESS_KEY" \
        "$DEVENV_STATE/rustfs"
    '';
    openbot = {
      after = [
        "devenv:processes:postgres"
        "devenv:processes:rustfs"
        "dev:install"
      ];
      exec = ''
        set -eu
        : "''${OPENBOT_SECRET_KEYS:?Run pnpm dev:setup first}"
        pnpm --filter-prod @openbot-build/openbot... build
        pnpm --filter @openbot-build/openbot migrate
        exec pnpm --filter @openbot-build/openbot start:development
      '';
      restart.on = "never";
      watch = {
        paths = builtins.map (name: ./packages + "/${name}/src") (
          builtins.filter (name: builtins.pathExists (./packages + "/${name}/src")) (
            builtins.attrNames (builtins.readDir ./packages)
          )
        );
      };
    };
  };

  packages = with pkgs; [
    git
    gh
    corepack
    docker-client
    # The test helpers start their own throwaway PostgreSQL with initdb and pg_ctl.
    postgresql_18
    # Checks for the Docker images. See the Deploy page in the docs.
    hadolint
    dive
    trivy
    mkcert
    openssl
    ripgrep
    rustfs
  ];

  env = {
    OPENBOT_DATABASE_URL =
      config.dotenv.resolved.OPENBOT_DATABASE_URL or "postgres://openbot_dev:openbot_dev@127.0.0.1:${
        config.dotenv.resolved.OPENBOT_DEV_DATABASE_PORT or "5433"
      }/${config.dotenv.resolved.OPENBOT_DEV_DATABASE_NAME or "openbot"}";
    OPENBOT_DEV_DATABASE_PORT = config.dotenv.resolved.OPENBOT_DEV_DATABASE_PORT or "5433";
    OPENBOT_DEV_DATABASE_NAME = config.dotenv.resolved.OPENBOT_DEV_DATABASE_NAME or "openbot";
    OPENBOT_HOST = "127.0.0.1";
    OPENBOT_PORT = config.dotenv.resolved.OPENBOT_DEV_HTTPS_PORT or "8443";
    OPENBOT_DEV_PUBLIC_ORIGIN = "https://localhost:${
      config.dotenv.resolved.OPENBOT_DEV_HTTPS_PORT or "8443"
    }";
    OPENBOT_TLS_CERT = "${config.devenv.root}/.devenv/dev/cert.pem";
    OPENBOT_TLS_KEY = "${config.devenv.root}/.devenv/dev/key.pem";
    OPENBOT_DEV_S3_PORT = config.dotenv.resolved.OPENBOT_DEV_S3_PORT or "9000";
    OPENBOT_DEV_S3_ENDPOINT = "http://127.0.0.1:${
      config.dotenv.resolved.OPENBOT_DEV_S3_PORT or "9000"
    }";
    OPENBOT_DEV_S3_BUCKET = "openbot";
    OPENBOT_DEV_S3_ACCESS_KEY_ID = "openbot_dev";
    OPENBOT_DEV_S3_SECRET_ACCESS_KEY = "openbot_dev_secret";
  };

  languages = {
    javascript = {
      enable = true;
      lsp.enable = false;
      package = multiverse.nodejs_26."26.12.0";
    };
  };

  treefmt = {
    enable = true;
    config = {
      projectRootFile = "devenv.nix";
      settings.global.excludes = [
        "references/**"
      ];
      programs = {
        prettier.enable = true;
        nixfmt.enable = true;
      };
    };
  };
}
