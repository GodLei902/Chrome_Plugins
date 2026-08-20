(function () {
  const EXTENSION_NAME = 'Social Comment Cleaner';

  const PLATFORM_RULES = [
    {
      id: 'instagram',
      hosts: ['instagram.com', 'www.instagram.com'],
      isPostPage: ({ pathname }) => /\/(p|reel)\/[^/]+/i.test(pathname),
    },
    {
      id: 'tiktok',
      hosts: ['www.tiktok.com'],
      isPostPage: ({ pathname }) => /\/@[^/]+\/video\/[^/]+/i.test(pathname),
    },
    {
      id: 'youtube',
      hosts: ['www.youtube.com', 'm.youtube.com'],
      isPostPage: ({ pathname, searchParams }) => pathname === '/watch' && searchParams.has('v'),
    },
    {
      id: 'facebook',
      hosts: ['facebook.com', 'www.facebook.com'],
      isPostPage: ({ pathname }) => pathname.includes('/posts/') || pathname.includes('/videos/'),
    },
  ];

  function detectCurrentPlatform(location) {
    const context = {
      host: location.hostname,
      pathname: location.pathname,
      searchParams: new URLSearchParams(location.search),
    };

    return PLATFORM_RULES.find((rule) => {
      return rule.hosts.includes(context.host) && rule.isPostPage(context);
    });
  }

  function bootstrap() {
    const platform = detectCurrentPlatform(window.location);

    if (!platform) {
      return;
    }

    console.debug(`[${EXTENSION_NAME}] content script loaded for ${platform.id}`);
    // Future work:
    // 1. Detect the configured target post for the current platform
    // 2. Apply whitelist filtering
    // 3. Remove nested comments under first-level comments
  }

  bootstrap();
})();
