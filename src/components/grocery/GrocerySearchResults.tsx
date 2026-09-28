import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ShoppingCart, Loader2, Package, CheckCircle2 } from 'lucide-react';
import type { GroceryProduct } from '@/hooks/useGroceryOrders';

interface GrocerySearchResultsProps {
  products: GroceryProduct[];
  query: string;
  store: string;
  onAddToCart: (items: GroceryProduct[]) => Promise<boolean>;
  addingToCart: boolean;
}

export default function GrocerySearchResults({
  products,
  query,
  store,
  onAddToCart,
  addingToCart,
}: GrocerySearchResultsProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [addedToCart, setAddedToCart] = useState(false);

  const toggleItem = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === products.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(products.map((_, i) => i)));
    }
  };

  const handleAddToCart = async () => {
    const items = Array.from(selected).map((i) => products[i]);
    const success = await onAddToCart(items);
    if (success) {
      setAddedToCart(true);
    }
  };

  if (products.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm" data-testid="text-no-results">No products found for "{query}"</p>
          <p className="text-xs mt-1">Try a different search term</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground" data-testid="text-result-count">
          {products.length} results from {store}
        </h3>
        <Button variant="ghost" size="sm" onClick={selectAll} data-testid="button-select-all">
          {selected.size === products.length ? 'Deselect All' : 'Select All'}
        </Button>
      </div>

      {products.map((product, i) => (
        <Card
          key={i}
          className={`transition-all cursor-pointer ${
            selected.has(i) ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/30'
          }`}
          onClick={() => toggleItem(i)}
          data-testid={`card-product-${i}`}
        >
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <Checkbox
                checked={selected.has(i)}
                onCheckedChange={() => toggleItem(i)}
                className="mt-1"
                data-testid={`checkbox-product-${i}`}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" data-testid={`text-product-name-${i}`}>
                  {product.name}
                </p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {product.price && (
                    <Badge variant="secondary" className="text-xs" data-testid={`text-product-price-${i}`}>
                      {product.price}
                    </Badge>
                  )}
                  {product.unit && (
                    <span className="text-xs text-muted-foreground">{product.unit}</span>
                  )}
                  {product.store && (
                    <span className="text-xs text-muted-foreground">from {product.store}</span>
                  )}
                </div>
              </div>
              <Badge
                variant={product.available ? 'default' : 'destructive'}
                className="shrink-0 text-xs"
              >
                {product.available ? 'In Stock' : 'Unavailable'}
              </Badge>
            </div>
          </CardContent>
        </Card>
      ))}

      {selected.size > 0 && !addedToCart && (
        <Button
          className="w-full"
          onClick={handleAddToCart}
          disabled={addingToCart}
          data-testid="button-add-to-cart"
        >
          {addingToCart ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Adding to cart…
            </>
          ) : (
            <>
              <ShoppingCart className="mr-2 h-4 w-4" />
              Add {selected.size} item{selected.size > 1 ? 's' : ''} to Cart
            </>
          )}
        </Button>
      )}

      {addedToCart && (
        <div className="flex items-center justify-center gap-2 py-3 text-sm text-green-500" data-testid="text-cart-success">
          <CheckCircle2 className="h-4 w-4" />
          Items added to your shopping cart
        </div>
      )}
    </div>
  );
}
