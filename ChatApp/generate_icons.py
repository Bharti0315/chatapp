from PIL import Image, ImageDraw
import os

def create_icon(size):
    """Create a chat icon with the specified size"""
    # Create a new image with blue background
    img = Image.new('RGB', (size, size), '#0056b3')
    
    # Create a drawing context
    draw = ImageDraw.Draw(img)
    
    # Calculate dimensions for the chat bubble
    margin = size // 4
    x1, y1 = margin, margin
    x2, y2 = size - margin, size - margin
    
    # Draw a white chat bubble
    draw.ellipse([x1, y1, x2, y2], fill='white')
    
    return img

def generate_all_icons():
    """Generate all required icons for the PWA"""
    # Create icons directory if it doesn't exist
    os.makedirs('static/images', exist_ok=True)

    # Generate icons for all required sizes
    sizes = [72, 96, 128, 144, 152, 192, 384, 512]
    for size in sizes:
        icon = create_icon(size)
        icon.save(f'static/images/icon-{size}x{size}.png', 'PNG', optimize=True)
        print(f"Generated icon-{size}x{size}.png")

    # Create shortcut icons
    shortcut_icon = create_icon(96)
    shortcut_icon.save('static/images/new-chat-96x96.png', 'PNG', optimize=True)
    shortcut_icon.save('static/images/recent-96x96.png', 'PNG', optimize=True)
    print("Generated shortcut icons")

if __name__ == '__main__':
    generate_all_icons() 