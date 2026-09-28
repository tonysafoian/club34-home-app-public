import { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAmazonOrders } from '@/hooks/useAmazonOrders';
import { Loader2, Clock, Search, ShoppingCart, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: typeof Clock }> = {
  pending: { label: 'Pending', variant: 'secondary', icon: Clock },
  searching: { label: 'Searching', variant: 'default', icon: Search },
  in_cart: { label: 'In Cart', variant: 'outline', icon: ShoppingCart },
  awaiting_approval: { label: 'Awaiting Approval', variant: 'outline', icon: AlertCircle },
  approved: { label: 'Approved', variant: 'default', icon: CheckCircle2 },
  ordering: { label: 'Ordering', variant: 'default', icon: ShoppingCart },
  ordered: { label: 'Ordered', variant: 'default', icon: CheckCircle2 },
  failed: { label: 'Failed', variant: 'destructive', icon: XCircle },
  cancelled: { label: 'Cancelled', variant: 'secondary', icon: XCircle },
};

export default function AmazonOrderHistory() {
  const { orders, fetchOrders, loadingOrders } = useAmazonOrders();

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  if (loadingOrders) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <ShoppingCart className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No order requests yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Recent Requests</h3>
      {orders.map((order) => {
        const config = statusConfig[order.status] || statusConfig.pending;
        const Icon = config.icon;

        return (
          <Card key={order.id} className="transition-all hover:shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{order.search_query}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(order.created_at).toLocaleString()}
                      {order.auto_order ? ' · Auto-order' : ' · Manual approval'}
                    </p>
                    {order.notes && (
                      <p className="text-xs text-muted-foreground mt-1">{order.notes}</p>
                    )}
                  </div>
                </div>
                <Badge variant={config.variant} className="shrink-0">
                  {config.label}
                </Badge>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
