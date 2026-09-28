import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, Plus, Trash2, ListChecks, Package } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { GroceryThumb } from '@/lib/groceryImage';
import { useToast } from '@/hooks/use-toast';

interface Staple {
  id: string;
  name: string;
  brand: string | null;
  size: string | null;
  default_quantity: number;
  category: string;
  platform: string;
  amazon_asin: string | null;
  amazon_url: string | null;
  image_url: string | null;
  unit_price: number | null;
  is_active: boolean;
  created_at: string;
}

const CATEGORIES = [
  'produce', 'dairy', 'bakery', 'meat', 'beverages',
  'snacks', 'frozen', 'pantry', 'household', 'personal-care', 'general',
];

const BLANK_FORM = {
  name: '',
  brand: '',
  size: '',
  quantity: 1,
  category: 'general',
  amazonAsin: '',
  amazonUrl: '',
  imageUrl: '',
  unitPrice: '',
};

export default function CatalogManager() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(BLANK_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ staples: Staple[] }>({
    queryKey: ['/api/grocery-staples'],
    queryFn: () => apiClient.get('/api/grocery-staples'),
  });

  const staples = data?.staples ?? [];

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/grocery-staples'] });
  }, [queryClient]);

  const handleAdd = async () => {
    if (!form.name.trim()) return;
    if (!form.imageUrl && !form.amazonAsin) {
      toast({ title: 'ASIN required', description: 'Please enter an Amazon ASIN when no image URL is provided.', variant: 'destructive' });
      return;
    }
    setAdding(true);
    try {
      if (editingId) {
        await apiClient.patch(`/api/grocery-staples/${editingId}`, {
          name: form.name.trim(),
          brand: form.brand.trim() || null,
          size: form.size.trim() || null,
          defaultQuantity: form.quantity,
          category: form.category,
          amazonAsin: form.amazonAsin.trim() || null,
          amazonUrl: form.amazonUrl.trim() || null,
          imageUrl: form.imageUrl.trim() || null,
          unitPrice: form.unitPrice ? parseFloat(form.unitPrice) : null,
        });
        toast({ title: 'Updated', description: `"${form.name.trim()}" updated.` });
      } else {
        await apiClient.post('/api/grocery-staples', {
          name: form.name.trim(),
          brand: form.brand.trim() || null,
          size: form.size.trim() || null,
          defaultQuantity: form.quantity,
          category: form.category,
          amazonAsin: form.amazonAsin.trim() || null,
          amazonUrl: form.amazonUrl.trim() || null,
          imageUrl: form.imageUrl.trim() || null,
          unitPrice: form.unitPrice ? parseFloat(form.unitPrice) : null,
        });
        toast({ title: 'Added', description: `"${form.name.trim()}" added to catalog.` });
      }
      setForm(BLANK_FORM);
      setEditingId(null);
      invalidate();
    } catch (err) {
      toast({ title: 'Error', description: 'Failed to save staple.', variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (staple: Staple) => {
    setEditingId(staple.id);
    setForm({
      name: staple.name,
      brand: staple.brand ?? '',
      size: staple.size ?? '',
      quantity: staple.default_quantity,
      category: staple.category,
      amazonAsin: staple.amazon_asin ?? '',
      amazonUrl: staple.amazon_url ?? '',
      imageUrl: staple.image_url ?? '',
      unitPrice: staple.unit_price != null ? String(staple.unit_price) : '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(BLANK_FORM);
  };

  const toggleStaple = async (id: string, current: boolean) => {
    setTogglingId(id);
    try {
      await apiClient.patch(`/api/grocery-staples/${id}`, { isActive: !current });
      invalidate();
    } catch {
      toast({ title: 'Error', description: 'Failed to update staple.', variant: 'destructive' });
    } finally {
      setTogglingId(null);
    }
  };

  const deleteStaple = async (id: string) => {
    setDeletingId(id);
    try {
      await apiClient.del(`/api/grocery-staples/${id}`);
      invalidate();
      toast({ title: 'Removed', description: 'Staple removed from catalog.' });
    } catch {
      toast({ title: 'Error', description: 'Failed to remove staple.', variant: 'destructive' });
    } finally {
      setDeletingId(null);
    }
  };

  const activeCount = staples.filter(s => s.is_active).length;
  const grouped = staples.reduce<Record<string, Staple[]>>((acc, s) => {
    (acc[s.category] = acc[s.category] || []).push(s);
    return acc;
  }, {});

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Manage Staples Catalog</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Items the household orders from. Add, edit, or hide items here. ({activeCount} active / {staples.length} total)
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-3 border border-border/60 rounded-lg p-3 bg-muted/20" data-testid="catalog-add-form">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {editingId ? 'Edit Item' : 'Add New Item'}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-name">Name *</Label>
              <Input
                id="catalog-name"
                placeholder="e.g. Whole Milk"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                data-testid="input-catalog-name"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-brand">Brand</Label>
              <Input
                id="catalog-brand"
                placeholder="e.g. Organic Valley"
                value={form.brand}
                onChange={e => setForm(f => ({ ...f, brand: e.target.value }))}
                data-testid="input-catalog-brand"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-size">Size / Unit</Label>
              <Input
                id="catalog-size"
                placeholder="e.g. 1 gallon"
                value={form.size}
                onChange={e => setForm(f => ({ ...f, size: e.target.value }))}
                data-testid="input-catalog-size"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-asin">
                Amazon ASIN {!form.imageUrl && <span className="text-destructive">*</span>}
              </Label>
              <Input
                id="catalog-asin"
                placeholder="e.g. B001234567"
                value={form.amazonAsin}
                onChange={e => setForm(f => ({ ...f, amazonAsin: e.target.value }))}
                data-testid="input-catalog-asin"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-image">Image URL</Label>
              <Input
                id="catalog-image"
                placeholder="https://..."
                value={form.imageUrl}
                onChange={e => setForm(f => ({ ...f, imageUrl: e.target.value }))}
                data-testid="input-catalog-image"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-amazon-url">Amazon URL</Label>
              <Input
                id="catalog-amazon-url"
                placeholder="https://amazon.com/dp/..."
                value={form.amazonUrl}
                onChange={e => setForm(f => ({ ...f, amazonUrl: e.target.value }))}
                data-testid="input-catalog-amazon-url"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-price">Unit Price ($)</Label>
              <Input
                id="catalog-price"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={form.unitPrice}
                onChange={e => setForm(f => ({ ...f, unitPrice: e.target.value }))}
                data-testid="input-catalog-price"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="catalog-qty">Default Qty</Label>
              <Input
                id="catalog-qty"
                type="number"
                min="1"
                value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: parseInt(e.target.value) || 1 }))}
                data-testid="input-catalog-qty"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="catalog-category">Category</Label>
            <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
              <SelectTrigger id="catalog-category" className="w-full" data-testid="select-catalog-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map(c => (
                  <SelectItem key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1).replace('-', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              onClick={handleAdd}
              disabled={adding || !form.name.trim()}
              size="sm"
              data-testid="button-catalog-save"
            >
              {adding ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
              {editingId ? 'Save changes' : 'Add to catalog'}
            </Button>
            {editingId && (
              <Button variant="ghost" size="sm" onClick={cancelEdit} data-testid="button-catalog-cancel">
                Cancel
              </Button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading catalog…</span>
          </div>
        ) : staples.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <Package className="h-7 w-7 mx-auto mb-2 opacity-40" />
            <p className="text-sm" data-testid="text-empty-catalog">No staples yet.</p>
            <p className="text-xs mt-0.5">Add items your family orders regularly.</p>
          </div>
        ) : (
          Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([category, items]) => (
            <div key={category} className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
                {category.replace('-', ' ')}
              </h4>
              {items.map(staple => (
                <div
                  key={staple.id}
                  className="flex items-center gap-3 py-2 px-2 rounded-md hover:bg-muted/50 group"
                  data-testid={`catalog-staple-${staple.id}`}
                >
                  <GroceryThumb
                    imageUrl={staple.image_url}
                    alt={[staple.brand, staple.name, staple.size].filter(Boolean).join(' ')}
                    href={staple.amazon_url || (staple.amazon_asin ? `https://www.amazon.com/dp/${staple.amazon_asin}` : null)}
                    wrapperClassName="w-12 h-12 rounded overflow-hidden bg-muted/40 flex items-center justify-center shrink-0"
                    testId={`catalog-thumb-${staple.id}`}
                  />
                  <Switch
                    checked={staple.is_active}
                    onCheckedChange={() => toggleStaple(staple.id, staple.is_active)}
                    disabled={togglingId === staple.id}
                    data-testid={`toggle-catalog-${staple.id}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${staple.is_active ? '' : 'line-through text-muted-foreground'}`}>
                      {staple.brand ? <span className="text-accent">{staple.brand}</span> : null}
                      {staple.brand ? ' ' : ''}{staple.name}
                    </p>
                    {staple.size && <p className="text-xs text-muted-foreground">{staple.size}</p>}
                  </div>
                  <Badge variant="secondary" className="text-xs shrink-0">×{staple.default_quantity}</Badge>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => startEdit(staple)}
                      data-testid={`button-edit-catalog-${staple.id}`}
                    >
                      <span className="text-xs">✎</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteStaple(staple.id)}
                      disabled={deletingId === staple.id}
                      data-testid={`button-delete-catalog-${staple.id}`}
                    >
                      {deletingId === staple.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Trash2 className="h-3 w-3" />
                      }
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
