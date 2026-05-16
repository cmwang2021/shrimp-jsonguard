{ pkgs, ... }: {
  channel = "stable-23.11";
  packages = [
    pkgs.nodejs_20
    pkgs.tailscale
    pkgs.openssh
  ];
  idx.workspace.onStart = {
    welcome = "echo 'Welcome to Shrimp JSONGuard Workshop! Testing infrastructure is ready.'";
    # 預留測試神經鏈路接口
    setup-test-net = "echo 'Waiting for TAILSCALE_AUTHKEY to bridge with Xiamen...'";
  };
}
