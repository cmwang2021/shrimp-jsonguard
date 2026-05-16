{ pkgs, ... }: {
  channel = "stable-23.11";
  packages = [
    pkgs.nodejs_20
  ];
  idx.workspace.onStart = {
    welcome = "echo 'Welcome to Shrimp JSONGuard Workshop! Run node test.js to see the magic.'";
  };
}
