# Tag Page Generator
# Generates a page for each tag at /tags/:tag/
# Works with GitHub Pages (safe mode compatible via Liquid)

module Jekyll
  class TagPageGenerator < Generator
    safe true

    def generate(site)
      tags = Set.new
      site.posts.docs.each { |p| p.data['tags']&.each { |t| tags << t } }
      site.collections['docs']&.docs&.each { |p| p.data['tags']&.each { |t| tags << t } }
      site.collections['research']&.docs&.each { |p| p.data['tags']&.each { |t| tags << t } }

      tags.each do |tag|
        slug = Utils.slugify(tag)
        site.pages << TagPage.new(site, site.source, File.join('tags', slug), tag)
      end
    end
  end

  class TagPage < Page
    def initialize(site, base, dir, tag)
      @site = site
      @base = base
      @dir = dir
      @name = 'index.html'

      self.process(@name)
      self.read_yaml(File.join(base, '_layouts'), 'tag.html')
      self.data['title'] = "Tag: #{tag}"
      self.data['tag'] = tag
      self.data['permalink'] = "/tags/#{Utils.slugify(tag)}/"
    end
  end
end
