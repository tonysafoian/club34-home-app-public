import { useState, useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from './useAuth';
import { useToast } from './use-toast';

interface OrderRequest {
  id: string;
  search_query: string;
  auto_order: boolean;
  status: string;
  cart_summary: unknown;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function useAmazonOrders() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [orders, setOrders] = useState<OrderRequest[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);

  const submitOrder = async (searchQuery: string, autoOrder: boolean) => {
    if (!user) return null;
    setSubmitting(true);

    try {
      const { data: insertedRows } = await apiClient.dbInsert<OrderRequest[]>('amazon_order_requests', {
        user_id: user.userId,
        search_query: searchQuery,
        auto_order: autoOrder,
        status: 'pending',
      });
      const orderData = insertedRows![0];

      await apiClient.post('/api/amazon-order', {
        action: 'search',
        orderId: orderData.id,
        searchQuery,
        autoOrder,
      });

      await apiClient.dbUpdate('amazon_order_requests', { status: 'searching' }, [
        { column: 'id', op: 'eq', value: orderData.id },
      ]);

      toast({ title: 'Order request submitted', description: 'The automation is searching Amazon now.' });
      return orderData;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit order';
      toast({ title: 'Error', description: message, variant: 'destructive' });
      return null;
    } finally {
      setSubmitting(false);
    }
  };

  const fetchOrders = useCallback(async () => {
    if (!user) return;
    setLoadingOrders(true);

    try {
      const { data } = await apiClient.dbQuery<OrderRequest[]>({
        table: 'amazon_order_requests',
        select: '*',
        order: { column: 'created_at', ascending: false },
        limit: 20,
      });
      setOrders(data ?? []);
    } catch (error) {
      console.error('Error fetching orders:', error);
    }
    setLoadingOrders(false);
  }, [user]);

  return { submitOrder, fetchOrders, orders, submitting, loadingOrders };
}
