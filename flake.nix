{
  description = "Declarative userscript manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-webext.url = "github:rivavolt/nix-webext";
  };

  outputs = { self, nixpkgs, nix-webext }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];
    in {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          host = pkgs.rustPlatform.buildRustPackage {
            pname = "userscripts-host";
            version = "0.1.0";
            src = ./host;
            cargoLock.lockFile = ./host/Cargo.lock;
          };

          popup = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "userscripts-popup";
            version = "0.1.0";
            src = ./popup;
            pnpmDeps = pkgs.pnpm_10.fetchDeps {
              inherit (finalAttrs) pname version src;
              hash = "sha256-i8OLpy5c41qnSOyFQXkEwsDY0+yn5Z1u3U7YwtHunUs=";
              fetcherVersion = 3;
            };
            nativeBuildInputs = [ pkgs.nodejs pkgs.pnpm_10 pkgs.pnpmConfigHook ];
            buildPhase = ''
              runHook preBuild
              pnpm vite build --outDir dist
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -r dist/* $out/
              runHook postInstall
            '';
          });

          extension = pkgs.stdenv.mkDerivation {
            pname = "userscripts-extension";
            version = "0.1.0";
            src = ./extension;
            dontBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              mkdir -p $out/share/chromium-extension $out/bin

              cp -r * $out/share/chromium-extension/
              cp -r ${popup} $out/share/chromium-extension/popup

              makeWrapper ${host}/bin/userscripts-host $out/bin/userscripts-host \
                --run 'exec 2> >(${pkgs.systemd}/bin/systemd-cat -t userscripts)'
            '';
          };

          manifest = builtins.fromJSON (builtins.readFile ./extension/manifest.json);
          geckoId = "userscripts@andreivolt";
          extId = "paaopceeojnejigehpccockddecaplbe";

          nativeMessaging = pkgs.linkFarm "userscripts-native-messaging" [
            { name = "etc/chromium/native-messaging-hosts/com.userscripts.host.json";
              path = pkgs.writeText "com.userscripts.host.json" (builtins.toJSON {
                name = "com.userscripts.host";
                description = "Userscripts native messaging host";
                path = "${extension}/bin/userscripts-host";
                type = "stdio";
                allowed_origins = [ "chrome-extension://${extId}/" ];
              });
            }
            { name = "lib/mozilla/native-messaging-hosts/com.userscripts.host.json";
              path = pkgs.writeText "com.userscripts.host.firefox.json" (builtins.toJSON {
                name = "com.userscripts.host";
                description = "Userscripts native messaging host";
                path = "${extension}/bin/userscripts-host";
                type = "stdio";
                allowed_extensions = [ geckoId ];
              });
            }
          ];

          # Chrome CRX (signed at activation) + Firefox XPI + native-messaging
          # hosts in `default`. extId is the stable Chrome ID the old committed key
          # derived (key now in fleet sops).
          ext = nix-webext.lib.mkBrowserExtension {
            inherit pkgs extension extId geckoId;
            pname = "userscripts";
            version = manifest.version;
            extraPaths = [ nativeMessaging ];
          };
        in {
          inherit host extension;
        } // ext);

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [ cargo rustc rust-analyzer ];
            shellHook = ''
              git config core.hooksPath .githooks 2>/dev/null || true
            '';
          };
        }
      );
    };
}
