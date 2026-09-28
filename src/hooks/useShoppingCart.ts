import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import { useToast } from './use-toast';

export interface CartItem {
  id: string;
  product_name: string;
  price: string | null;
  quantity: number;
  platform: string;
  notes: string | null;
  product_url: string | null;
  image_url: string | null;
  added_by: string;
  status: string;
  created_at: string;
}

export function useShoppingCart() {
  const { toast } = useToast();
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const fetchCart = useCallback(async () => {
    try {
      const data = await apiClient.get<{ items: CartItem[] }>('/api/shopping-cart');
      setItems(data.items || []);
    } catch (err) {
      console.error('Failed to fetch cart:', err);
      toast({ title: 'Error', description: 'Failed to load shopping cart', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchCart();
  }, [fetchCart]);

  const removeItem = async (id: string) => {
    setUpdating(id);
    try {
      await apiClient.patch(`/api/shopping-cart/${id}`, { status: 'cleared' });
      setItems((prev) => prev.filter((item) => item.id !== id));
      toast({ title: 'Removed', description: 'Item removed from cart' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove item';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setUpdating(null);
    }
  };

  const updateQuantity = async (id: string, quantity: number) => {
    if (quantity < 1) return;
    setUpdating(id);
    try {
      await apiClient.patch(`/api/shopping-cart/${id}`, { quantity });
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, quantity } : item))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update quantity';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setUpdating(null);
    }
  };

  const clearCart = async () => {
    setClearing(true);
    try {
      await apiClient.post('/api/shopping-cart/clear');
      setItems([]);
      toast({ title: 'Cart cleared', description: 'All items have been removed from your cart' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear cart';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setClearing(false);
    }
  };

  return {
    items,
    loading,
    updating,
    clearing,
    fetchCart,
    removeItem,
    updateQuantity,
    clearCart,
  };
}
