{
  pkgs,
  multiverse,
  ...
}:

{
  devenv.warnOnNewVersion = false;

  tasks."dev:install".exec = "pnpm install --frozen-lockfile";

  packages = with pkgs; [
    git
    gh
    corepack
    ripgrep
  ];

  languages = {
    javascript = {
      enable = true;
      lsp.enable = false;
      package = multiverse.nodejs_26."26.6.0";
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
