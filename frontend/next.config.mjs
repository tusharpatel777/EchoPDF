/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['react-markdown', 'remark-gfm', 'remark-parse', 'unified', 'vfile', 'vfile-message', 'unist-util-stringify-position'],
};

export default nextConfig;
