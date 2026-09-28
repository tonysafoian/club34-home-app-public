import { useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from './useAuth';
import { useToast } from './use-toast';

export interface GroceryProduct {
  name: string;
  price: string;
  unit: string;
  store: string;
  available: boolean;
}

interface SearchResult {
  products: GroceryProduct[];
  store: string;
  query: string;
  sessionReplay?: string;
}

export function useGroceryOrders() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [addingToCart, setAddingToCart] = useState(false);

  const searchGroceries = async (searchQuery: string, store = 'amazon-fresh') => {
    if (!user) return null;
    setSearching(true);
    setResults(null);

    try {
      const data = await apiClient.post<SearchResult & { success?: boolean; error?: string }>('/api/grocery-order', {
        action: 'search',
        searchQuery,
        store,
      });

      if (data?.success) {
        setResults(data as SearchResult);
        toast({ title: 'Search complete', description: `Found ${data.products?.length || 0} products on ${store}` });
        return data as SearchResult;
      } else {
        toast({ title: 'Search failed', description: data?.error || 'Unknown error', variant: 'destructive' });
        return null;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to search groceries';
      toast({ title: 'Error', description: message, variant: 'destructive' });
      return null;
    } finally {
      setSearching(false);
    }
  };

  const addToCart = async (items: GroceryProduct[]) => {
    if (!user) return false;
    setAddingToCart(true);

    try {
      const data = await apiClient.post<{ success?: boolean; error?: string }>('/api/grocery-order', {
        action: 'add_to_cart',
        items: items.map((item) => ({
          name: item.name,
          price: item.price,
          quantity: 1,
          unit: item.unit || null,
        })),
      });

      if (!data?.success) throw new Error(data?.error || 'Failed to add items');

      toast({ title: 'Added to cart', description: `${items.length} item(s) added to your shopping cart` });
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to add to cart';
      toast({ title: 'Error', description: message, variant: 'destructive' });
      return false;
    } finally {
      setAddingToCart(false);
    }
  };

  return { searchGroceries, addToCart, results, searching, addingToCart, setResults };
}
