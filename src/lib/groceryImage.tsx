import { useState, useEffect } from 'react';
import { Package } from 'lucide-react';

function groceryImageSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  return `/api/grocery/image?url=${encodeURIComponent(url)}`;
}

interface GroceryProductImageProps {
  url: string | null | undefined;
  alt: string;
  className?: string;
  iconClassName?: string;
}

interface GroceryThumbProps {
  imageUrl: string | null | undefined;
  alt: string;
  href?: string | null;
  wrapperClassName: string;
  testId?: string;
}

export function GroceryThumb({ imageUrl, alt, href, wrapperClassName, testId }: GroceryThumbProps) {
  const img = <GroceryProductImage url={imageUrl} alt={alt} />;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${wrapperClassName} hover:ring-2 hover:ring-primary/40 transition`}
        title="View on Amazon"
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
      >
        {img}
      </a>
    );
  }
  return (
    <div className={wrapperClassName} data-testid={testId}>
      {img}
    </div>
  );
}

export function GroceryProductImage({ url, alt, className = 'w-full h-full object-contain', iconClassName = 'h-5 w-5 text-muted-foreground/50' }: GroceryProductImageProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  const src = groceryImageSrc(url);
  if (!src || failed) {
    return <Package className={iconClassName} />;
  }
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
