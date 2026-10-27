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
    if [ ! -f .env.development ]; then
      sed -e "s/^OPENBOT_SECRET_KEYS=$/OPENBOT_SECRET_KEYS=dev:$(openssl rand -hex 32)/" \
        -e "s/^OPENBOT_CLUSTER_SECRET=$/OPENBOT_CLUSTER_SECRET=$(openssl rand -hex 32)/" \
        .env.development.example > .env.development
    fi
    if ! rg -q '^OPENBOT_CLUSTER_SECRET=' .env.development; then
      printf '\nOPENBOT_CLUSTER_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.development
    fi
    echo "Run pnpm dev to sign in with the local development account."
  '';

  tasks."dev:install".exec = "pnpm install --frozen-lockfile";

  # The shared proxy gives a process a stable name on port 80, whatever port
  # devenv picks for it. On Linux, it asks for sudo to listen on port 80.
  process.proxy.enable = true;

  processes =
    let
      # devenv finds a free port from each base port. Only the processes read
      # these values, so a shell never sees a port that a process does not use.
      postgresPort = toString config.processes.postgres.ports.postgres.value;
      s3Port = toString config.processes.rustfs.ports.s3.value;
      httpPort = toString config.processes.openbot.ports.http.value;
      s3Endpoint = "http://127.0.0.1:${s3Port}";
    in
    {
      # The development database runs in Docker, from the same image as
      # deploy/docker/compose.production.yaml. Its data lives in the Docker
      # volume openbot-dev-postgres.
      postgres = {
        ports.postgres.allocate = 5433;
        ready.exec = "pg_isready --quiet --host 127.0.0.1 --port ${postgresPort}";
        exec = ''
          set -eu
          docker rm --force openbot-dev-postgres >/dev/null 2>&1 || true
          exec docker run --rm --name openbot-dev-postgres \
            --publish "127.0.0.1:${postgresPort}:5432" \
            --volume openbot-dev-postgres:/var/lib/postgresql \
            --env POSTGRES_USER=openbot_dev \
            --env POSTGRES_PASSWORD=openbot_dev \
            --env POSTGRES_DB="$OPENBOT_DEV_DATABASE_NAME" \
            postgres:18.6-alpine3.24@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5
        '';
      };
      # The development object storage for files. It speaks the S3 API. It runs
      # in Docker, and its data lives in the Docker volume openbot-dev-rustfs.
      # The development entry makes the bucket. An empty
      # RUSTFS_OBS_LOG_DIRECTORY sends the RustFS logs to the output.
      rustfs = {
        ports.s3.allocate = 9000;
        # Docker takes connections on the published port before RustFS is up,
        # so a TCP check is not enough. The health path answers only when it is up.
        ready.exec = "curl --fail --silent --output /dev/null ${s3Endpoint}/minio/health/live";
        exec = ''
          set -eu
          docker rm --force openbot-dev-rustfs >/dev/null 2>&1 || true
          exec docker run --rm --name openbot-dev-rustfs \
            --publish "127.0.0.1:${s3Port}:9000" \
            --volume openbot-dev-rustfs:/data \
            --env RUSTFS_ACCESS_KEY="$OPENBOT_DEV_S3_ACCESS_KEY_ID" \
            --env RUSTFS_SECRET_KEY="$OPENBOT_DEV_S3_SECRET_ACCESS_KEY" \
            --env RUSTFS_OBS_LOG_DIRECTORY= \
            rustfs/rustfs:1.0.3@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b
        '';
      };
      # The proxy serves OpenBot at http://localhost.
      openbot = {
        after = [
          "devenv:processes:postgres"
          "devenv:processes:rustfs"
          "dev:install"
        ];
        ports.http.allocate = 3000;
        proxy.hostname = "localhost";
        env = {
          OPENBOT_PORT = httpPort;
          # Set it in .env.development when the proxy listens on another port,
          # with DEVENV_PROXY_LISTEN.
          OPENBOT_DEV_PUBLIC_ORIGIN = config.dotenv.resolved.OPENBOT_DEV_PUBLIC_ORIGIN or "http://localhost";
          OPENBOT_DATABASE_URL =
            config.dotenv.resolved.OPENBOT_DATABASE_URL
              or "postgres://openbot_dev:openbot_dev@127.0.0.1:${postgresPort}/${config.env.OPENBOT_DEV_DATABASE_NAME}";
          OPENBOT_DEV_S3_ENDPOINT = s3Endpoint;
        };
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
    curl
    corepack
    docker-client
    # The test helpers start their own throwaway PostgreSQL with initdb and pg_ctl.
    postgresql_18
    # Checks for the Docker images. See the Deploy page in the docs.
    hadolint
    dive
    trivy
    openssl
    ripgrep
  ];

  env = {
    OPENBOT_DEV_DATABASE_NAME = config.dotenv.resolved.OPENBOT_DEV_DATABASE_NAME or "openbot";
    OPENBOT_HOST = "127.0.0.1";
    OPENBOT_DEV_S3_BUCKET = "openbot";
    OPENBOT_DEV_S3_ACCESS_KEY_ID = "openbot_dev";
    OPENBOT_DEV_S3_SECRET_ACCESS_KEY = "openbot_dev_secret";
  };

  languages = {
    javascript = {
      enable = true;
      lsp.enable = false;
      package = multiverse.nodejs_26."26.12.1";
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
