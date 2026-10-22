import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal, Package } from 'lucide-react';
import { fetchCategories } from '../../lib/productService';

interface CategoryItem {
  id: string;
  name: string;
  image_url?: string;
}

/**
 * CategoryItem Component
 * Displays a single category as a circular shortcut with image and name
 * Perfect alignment with fixed dimensions for professional appearance
 */
const CategoryItem: React.FC<{ category: CategoryItem; isMore?: boolean }> = ({
  category,
  isMore = false,
}) => {
  const [imgError, setImgError] = useState(false);

  return (
    <Link
      to={isMore ? '/all-categories' : `/category/${category.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        cursor: 'pointer',
        textDecoration: 'none',
        width: '100%',
      }}
    >
      {/* Circle - 96px */}
      <div
        style={{
          width: 'clamp(68px, 16vw, 96px)',
          height: 'clamp(68px, 16vw, 96px)',
          borderRadius: '9999px',
          backgroundColor: '#F0F4FF',
          border: '1.5px solid #E0E7FF',
          boxShadow: '0 2px 10px rgba(0,0,0,0.07)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-4px)';
          (e.currentTarget as HTMLDivElement).style.boxShadow = '0 8px 20px rgba(0,0,0,0.13)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
          (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 10px rgba(0,0,0,0.07)';
        }}
      >
        {isMore ? (
          <MoreHorizontal size={34} color="#6B7280" strokeWidth={2} />
        ) : category.image_url && !imgError ? (
          <img
            src={category.image_url}
            alt={category.name}
            style={{
              width: 'clamp(68px, 16vw, 96px)',
              height: 'clamp(68px, 16vw, 96px)',
              objectFit: 'cover',
              borderRadius: '9999px',
            }}
            onError={() => setImgError(true)}
          />
        ) : (
          <Package size={32} color="#CBD5E1" strokeWidth={1.5} />
        )}
      </div>

      {/* Label */}
      <p
        style={{
          marginTop: '10px',
          fontSize: 'clamp(11px, 2.8vw, 12.5px)',
          fontWeight: 600,
          color: '#1a1a1a',
          textAlign: 'center',
          lineHeight: '1.3',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          width: '100%',
          padding: '0 4px',
          boxSizing: 'border-box',
          minHeight: '34px',
          margin: 0,
        }}
      >
        {category.name}
      </p>
    </Link>
  );
};

const imageMap: { [key: string]: string } = {
  'Electronics': '/images/ELECTRONICS.png',
  'Fashion': '/images/FASHION.png',
  'Beauty & Health': '/images/BEAUTY_AND_PERSONAL_CARE.png',
  'Beauty & Personal Care': '/images/BEAUTY_AND_PERSONAL_CARE.png',
  'Home & Garden': '/images/HOME_AND_GARDEN.png',
  'Grocery': '/images/GROCERY.png',
  'Grocery & Gourmet Food': '/images/GROCERY_AND_GOURMET_FOOD.png',
  'Grocery & Gourmet': '/images/GROCERY_AND_GOURMET_FOOD.png',
  'Health, Household & Baby Care': '/images/HEALTH_HOUSEHOLD_AND_BABY_CARE.png',
  'Health, Household & Baby': '/images/HEALTH_HOUSEHOLD_AND_BABY_CARE.png',
  'Sports & Outdoors': '/images/SPORTS_AND_OUTDOORS.png',
  'Sports, Fitness & Outdoors': '/images/SPORTS_AND_OUTDOORS.png',
  'Books': '/images/BOOKS.png',
  'Books & Media': '/images/BOOKS.png',
  'Toys, Games & Baby Products': '/images/TOYS_GAMES_AND_BABY_PRODUCTS.png',
  'Toys & Baby': '/images/TOYS_GAMES_AND_BABY_PRODUCTS.png',
  'Automotive & Industrial': '/images/AUTOMOTIVE_AND_INDUSTRIAL.png',
  'Automotive': '/images/AUTOMOTIVE_AND_INDUSTRIAL.png',
  'Jewellery & Luxury': '/images/JEWELLERY_AND_LUXURY.png',
  'Medical Equipment & Supplies': '/images/MEDICAL_EQUIPMENT_AND_SUPPLIES.png',
  'Safety & PPE': '/images/SAFETY_AND_PPE.png',
  'Software & Digital Products': '/images/SOFTWARE_AND_DIGITAL_PRODUCTS.png',
  'Industrial & Lab Supplies': '/images/INDUSTRIAL_AND_LAB_SUPPLIES.png',
  'Office Supplies & Stationery': '/images/OFFICE_SUPPLIES_AND_STATIONERY.png',
  'Gifts & Celebrations': '/images/GIFTS_AND_CELEBRATIONS.png',
  'Combo Offers': '/images/COMBO_OFFERS.png',
  'Home Appliances': '/images/HOME_APPLIANCES.png',
  'Musical Instruments': '/images/MUSICAL_INSTRUMENTS.png',
  'Garden & Outdoor Living': '/images/GARDEN_AND_OUTDOOR_LIVING.png',
  'Travel & Luggage': '/images/TRAVEL_AND_LUGGAGE.png',
};

export const Categories: React.FC = () => {
  const [categories, setCategories] = useState<CategoryItem[]>([]);

  useEffect(() => {
    fetchCategories().then(({ data }) => {
      setCategories(
        data.map((c: any) => ({
          id: c.id,
          name: c.name,
          image_url: imageMap[c.name] || c.image_url,
        }))
      );
    });
  }, []);

  // Show first 16 categories across 2 rows of 8
  const visible = categories.slice(0, 16);

  return (
    <div style={{ padding: '16px 0' }}>
      <style>{`
        .category-grid {
          display: grid;
          grid-template-columns: repeat(8, minmax(0, 1fr));
          gap: 12px 8px;
          justify-items: center;
        }

        @media (max-width: 1024px) {
          .category-grid {
            grid-template-columns: repeat(6, minmax(0, 1fr));
          }
        }

        @media (max-width: 768px) {
          .category-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 10px 6px;
          }
        }

        @media (max-width: 480px) {
          .category-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 10px 6px;
          }
        }
      `}</style>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="category-grid">
          {visible.map((category) => (
            <CategoryItem key={category.id} category={category} />
          ))}
        </div>
      </div>
    </div>
  );
};
