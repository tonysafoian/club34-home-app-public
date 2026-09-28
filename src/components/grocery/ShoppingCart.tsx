import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShoppingCart as CartIcon, Trash2, Minus, Plus, Loader2, ShoppingBag, X } from 'lucide-react';
import type { CartItem } from '@/hooks/useShoppingCart';
import { GroceryThumb } from '@/lib/groceryImage';

interface ShoppingCartProps {
  items: CartItem[];
  loading: boolean;
  updating: string | null;
  clearing: boolean;
  onRemove: (id: string) => void;
  onUpdateQuantity: (id: string, quantity: number) => void;
  onClear: () => void;
}

export default function ShoppingCart({
  items,
  loading,
  updating,
  clearing,
  onRemove,
  onUpdateQuantity,
  onClear,
}: ShoppingCartProps) {
  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading cart…</span>
        </CardContent>
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <ShoppingBag className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm" data-testid="text-empty-cart">Your shopping cart is empty</p>
          <p className="text-xs mt-1">Search for items above or ask Janus to add them</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="shopping-cart">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CartIcon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium" data-testid="text-cart-count">
            Shopping Cart ({items.length} item{items.length !== 1 ? 's' : ''})
          </h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={clearing}
          className="text-destructive hover:text-destructive"
          data-testid="button-clear-cart"
        >
          {clearing ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="mr-1 h-3 w-3" />
          )}
          Clear All
        </Button>
      </div>

      {items.map((item) => (
        <Card key={item.id} data-testid={`cart-item-${item.id}`}>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <GroceryThumb
                imageUrl={item.image_url}
                alt={item.product_name}
                href={item.product_url}
                wrapperClassName="flex items-center justify-center w-14 h-14 rounded-md overflow-hidden bg-muted/60 shrink-0"
                testId={`img-cart-item-${item.id}`}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" data-testid={`text-cart-item-name-${item.id}`}>
                  {item.product_name}
                </p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {item.price && (
                    <Badge variant="secondary" className="text-xs" data-testid={`text-cart-item-price-${item.id}`}>
                      {item.price}
                    </Badge>
                  )}
                  {item.platform && (
                    <span className="text-xs text-muted-foreground">{item.platform}</span>
                  )}
                  {item.notes && (
                    <span className="text-xs text-muted-foreground italic">{item.notes}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onUpdateQuantity(item.id, item.quantity - 1)}
                  disabled={item.quantity <= 1 || updating === item.id}
                  data-testid={`button-decrease-${item.id}`}
                >
                  <Minus className="h-3 w-3" />
                </Button>
                <span className="w-8 text-center text-sm font-medium" data-testid={`text-cart-item-qty-${item.id}`}>
                  {updating === item.id ? (
                    <Loader2 className="h-3 w-3 animate-spin mx-auto" />
                  ) : (
                    item.quantity
                  )}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
                  disabled={updating === item.id}
                  data-testid={`button-increase-${item.id}`}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => onRemove(item.id)}
                disabled={updating === item.id}
                data-testid={`button-remove-${item.id}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
