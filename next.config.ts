import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@google-cloud/storage', 'ssh2', 'mysql2'],
};

export default nextConfig;
