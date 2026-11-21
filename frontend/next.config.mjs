/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Na serwerze przeglądarka zna jeden adres, a /api trafia z Next do API.
  // Wartość API_INTERNAL_URL jest czytana przy budowaniu.
  async rewrites() {
    const api = process.env.API_INTERNAL_URL;
    return api ? [{ source: "/api/:path*", destination: `${api.replace(/\/$/, "")}/api/:path*` }] : [];
  }
};

export default nextConfig;
