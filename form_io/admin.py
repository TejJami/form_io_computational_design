from django.contrib import admin

# Register your models here.

from .models import Project
@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ('name', 'type', 'blocks_envelope', 'created_at')
    search_fields = ('name', 'type', 'blocks_envelope')
    list_filter = ('type',)
    ordering = ('-created_at',)
    readonly_fields = ('created_at',)

    fieldsets = (
        (None, {
            'fields': ('name', 'type', 'blocks_envelope', "site_bounds" , 'site_envelope', 'inputs', )
        }),
        ('Metadata', {
            'fields': ('created_at',),
            'classes': ('collapse',)
        }),
    )