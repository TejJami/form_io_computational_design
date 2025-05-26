from django.contrib import admin

# Register your models here.

from .models import Project
@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ('name', 'type', 'location', 'created_at')
    search_fields = ('name', 'type', 'location')
    list_filter = ('type',)
    ordering = ('-created_at',)
    readonly_fields = ('created_at',)

    fieldsets = (
        (None, {
            'fields': ('name', 'type', 'location', 'site_geometry', 'inputs', 'thumbnail')
        }),
        ('Metadata', {
            'fields': ('created_at',),
            'classes': ('collapse',)
        }),
    )