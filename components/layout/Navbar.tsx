'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BarChart3, LogOut, LayoutDashboard, PieChart, UserMinus, RotateCcw, MessageSquare, MessageSquareWarning, Smile } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const navItems = [
  { label: 'MRR Revenue', href: '/dashboard', icon: LayoutDashboard },
  { label: 'MRR Breakdown', href: '/dashboard/breakdown', icon: PieChart },
  { label: 'Churn', href: '/dashboard/churn', icon: UserMinus },
  { label: 'Refunds', href: '/dashboard/refunds', icon: RotateCcw },
  { label: 'Reviews', href: '/dashboard/reviews', icon: MessageSquare },
  { label: 'Voice of Refund', href: '/dashboard/refund-voice', icon: MessageSquareWarning },
  { label: 'NPS', href: '/dashboard/nps', icon: Smile },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch('/api/auth', { method: 'DELETE' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="bg-gradient-to-r from-[#0E3687] to-[#0A2A6B] shadow-lg">
      <div className="flex h-16 items-center px-6 max-w-[1400px] mx-auto">
        {/* Logo */}
        <div className="flex items-center gap-3 mr-10">
          <div className="h-9 w-9 rounded-lg bg-white/15 flex items-center justify-center">
            <BarChart3 className="h-5 w-5 text-white" />
          </div>
          <div>
            <span className="font-semibold text-white text-sm tracking-wide">MRR Dashboard</span>
            <span className="block text-[10px] text-white/50 -mt-0.5">Revenue Analytics</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex items-center gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg transition-all duration-200',
                  pathname === item.href
                    ? 'bg-white/15 text-white font-medium shadow-sm'
                    : 'text-white/60 hover:text-white hover:bg-white/10'
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Right side */}
        <div className="ml-auto flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="text-white/60 hover:text-white hover:bg-white/10"
          >
            <LogOut className="h-4 w-4 mr-1.5" />
            Logout
          </Button>
        </div>
      </div>
    </header>
  );
}
