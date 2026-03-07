{
  description = "Declarative userscript manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
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

          extension = pkgs.stdenv.mkDerivation {
            pname = "userscripts-extension";
            version = "0.1.0";
            src = ./extension;
            dontBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              mkdir -p $out/share/chromium-extension $out/bin

              cp -r * $out/share/chromium-extension/

              makeWrapper ${host}/bin/userscripts-host $out/bin/userscripts-host \
                --run 'exec 2> >(${pkgs.systemd}/bin/systemd-cat -t userscripts)'
            '';
          };

          manifest = builtins.fromJSON (builtins.readFile "${extension}/share/chromium-extension/manifest.json");

          extId = builtins.readFile (pkgs.runCommand "userscripts-ext-id" {
            nativeBuildInputs = [ pkgs.python3 pkgs.openssl ];
          } ''
            python3 ${./nix/crx-id.py} ${./keys/signing.pem} > $out
          '');

          crx = pkgs.runCommand "userscripts-crx" {
            nativeBuildInputs = [ pkgs.python3 pkgs.openssl ];
          } ''
            mkdir -p $out
            python3 ${./nix/pack-crx3.py} ${extension}/share/chromium-extension ${./keys/signing.pem} $out/extension.crx
          '';

        in {
          inherit host extension;
          default = pkgs.symlinkJoin {
            name = "userscripts";
            paths = [
              extension
              (pkgs.linkFarm "userscripts-crx" [
                { name = "share/chromium/extensions/${extId}.json";
                  path = pkgs.writeText "${extId}.json" (builtins.toJSON {
                    external_crx = "${crx}/extension.crx";
                    external_version = manifest.version;
                  });
                }
                { name = "etc/chromium/native-messaging-hosts/com.userscripts.host.json";
                  path = pkgs.writeText "com.userscripts.host.json" (builtins.toJSON {
                    name = "com.userscripts.host";
                    description = "Userscripts native messaging host";
                    path = "${extension}/bin/userscripts-host";
                    type = "stdio";
                    allowed_origins = [ "chrome-extension://${extId}/" ];
                  });
                }
              ])
            ];
          };
        }
      );

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [ cargo rustc rust-analyzer ];
          };
        }
      );
    };
}
