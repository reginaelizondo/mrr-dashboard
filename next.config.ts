import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@google-cloud/storage', 'ssh2'],
};

export default nextConfig;
