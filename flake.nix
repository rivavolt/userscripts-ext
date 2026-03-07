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
        in {
          inherit host;
          default = pkgs.stdenv.mkDerivation {
            pname = "userscripts";
            version = "0.1.0";
            src = ./extension;
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/share/chromium-extension \
                $out/etc/chromium/native-messaging-hosts \
                $out/bin

              cp -r * $out/share/chromium-extension/
              ln -s ${host}/bin/userscripts-host $out/bin/userscripts-host

              cat > $out/etc/chromium/native-messaging-hosts/com.userscripts.host.json <<EOF
              {
                "name": "com.userscripts.host",
                "description": "Userscripts native messaging host",
                "path": "${host}/bin/userscripts-host",
                "type": "stdio",
                "allowed_origins": [
                  "chrome-extension://paaopceeojnejigehpccockddecaplbe/"
                ]
              }
              EOF
            '';
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
