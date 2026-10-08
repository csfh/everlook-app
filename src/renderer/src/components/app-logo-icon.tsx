import type { ImgHTMLAttributes } from 'react'
import logo from '@/assets/logo.png'

export function AppLogoIcon(props: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'>) {
  return <img src={logo} alt="" aria-hidden="true" draggable={false} {...props} />
}
