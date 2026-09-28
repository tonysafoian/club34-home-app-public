import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, UtensilsCrossed, Search, MapPin, Clock, Star } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useState } from 'react';

const SAMPLE_RESTAURANTS = [
  {
    id: 'rest-1',
    name: 'Thai Basil Kitchen',
    cuisine: 'Thai',
    rating: 4.7,
    deliveryTime: '30-40 min',
    distance: '2.1 mi',
  },
  {
    id: 'rest-2',
    name: 'Napoli Pizza Co.',
    cuisine: 'Italian',
    rating: 4.5,
    deliveryTime: '25-35 min',
    distance: '1.8 mi',
  },
  {
    id: 'rest-3',
    name: 'Sushi Wave',
    cuisine: 'Japanese',
    rating: 4.8,
    deliveryTime: '35-45 min',
    distance: '3.0 mi',
  },
  {
    id: 'rest-4',
    name: 'Burger District',
    cuisine: 'American',
    rating: 4.3,
    deliveryTime: '20-30 min',
    distance: '1.2 mi',
  },
];

export default function FoodDeliveryOrder() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredRestaurants = SAMPLE_RESTAURANTS.filter(
    (r) =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.cuisine.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/automations')} data-testid="button-back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold font-display">Food Delivery</h1>
            <p className="text-xs text-muted-foreground">Browse restaurants & order food for delivery</p>
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-6 max-w-2xl">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search restaurants or cuisines..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-restaurants"
          />
        </div>

        <div className="space-y-3">
          {filteredRestaurants.length > 0 ? (
            filteredRestaurants.map((restaurant) => (
              <Card
                key={restaurant.id}
                className="cursor-pointer hover:bg-muted/40 transition-colors group"
                data-testid={`card-restaurant-${restaurant.id}`}
              >
                <CardHeader className="py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
                      <UtensilsCrossed className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base" data-testid={`text-restaurant-name-${restaurant.id}`}>
                        {restaurant.name}
                      </CardTitle>
                      <CardDescription className="text-xs">{restaurant.cuisine}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-4">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                      {restaurant.rating}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {restaurant.deliveryTime}
                    </span>
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {restaurant.distance}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <p className="text-muted-foreground text-sm text-center py-8" data-testid="text-no-results">
              No restaurants found matching "{searchQuery}"
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
