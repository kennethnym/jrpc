{
  description = "Development environment for @nym.sh/jrpc";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          let
            pkgs = import nixpkgs { inherit system; };
          in
          f pkgs
        );
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          nodejs = pkgs.nodejs_24 or pkgs.nodejs;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              nodejs
              pkgs.git
              pkgs.gh
            ];

            shellHook = ''
              echo "jrpc dev shell"
              echo "  bun:  $(bun --version)"
              echo "  node: $(node --version)"
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
