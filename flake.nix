{
  description = "Declarative userscript manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-crx.url = "github:andreivolt/nix-crx";
  };

  outputs = { self, nixpkgs, nix-crx }:
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

          crxPkg = nix-crx.lib.mkCrxPackage {
            inherit pkgs extension;
            key = ./keys/signing.pem;
            name = "userscripts";
          };

        in {
          inherit host extension;
          default = pkgs.symlinkJoin {
            name = "userscripts";
            paths = [
              extension
              crxPkg.package
              (pkgs.linkFarm "userscripts-native" [
                { name = "etc/chromium/native-messaging-hosts/com.userscripts.host.json";
                  path = pkgs.writeText "com.userscripts.host.json" (builtins.toJSON {
                    name = "com.userscripts.host";
                    description = "Userscripts native messaging host";
                    path = "${extension}/bin/userscripts-host";
                    type = "stdio";
                    allowed_origins = [ "chrome-extension://${crxPkg.extId}/" ];
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
