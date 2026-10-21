{
  lib,
  stdenv,
  stdenvNoCC,
  fetchurl,
  autoPatchelfHook,
  versionCheckHook,
}:
let
  version = "26.12.1";
  archives = {
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "18830bf448fe187c650dc28c98aa8c968ed1d40b6dd032c081e70a384a1bf660";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "69316aaafb4dfcb25ac7b9a460f5c60928a37580284fde410144d0e6c8672d0f";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "42aa04922591ee5d4dbc7740d452621acf28508239daa512f5ee8c47ee224fdb";
    };
    x86_64-linux = {
      platform = "linux-x64";
      hash = "6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd";
    };
  };
  archive =
    archives.${stdenv.hostPlatform.system}
      or (throw "The pinned Node.js release supports Linux and macOS on x86_64 and aarch64.");
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "nodejs";
  inherit version;
  # Keep the security release's bundled dependencies on development and CI hosts.
  src = fetchurl {
    url = "https://nodejs.org/dist/v${version}/node-v${version}-${archive.platform}.tar.xz";
    sha256 = archive.hash;
  };
  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -R bin include lib share "$out/"
    runHook postInstall
  '';
  postFixup = ''
    substituteInPlace "$out/lib/node_modules/npm/bin/npm-cli.js" "$out/lib/node_modules/npm/bin/npx-cli.js" \
      --replace-fail '#!/usr/bin/env node' "#!$out/bin/node"
  '';
  nativeInstallCheckInputs = [ versionCheckHook ];
  doInstallCheck = true;
  versionCheckProgramArg = "--version";
  passthru.npm = finalAttrs.finalPackage;
  meta = {
    description = "Official Node.js security release with bundled dependencies";
    homepage = "https://nodejs.org";
    license = lib.licenses.mit;
    mainProgram = "node";
    platforms = builtins.attrNames archives;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
})
